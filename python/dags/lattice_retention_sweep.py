"""
Lattice Retention Sweep DAG

Identifies emails eligible for deletion based on retention policy and publishes
deletion requests to Kafka for the mail-deleter worker to execute.

Features:
- Configurable cutoff date (default: 365 days ago)
- Bounded batch processing with max_emails_per_run
- Resumable via checkpoint tracking in retention_sweep_run table
- Idempotent: skips completed sweeps unless force=true

Usage:
    Trigger via Airflow UI or CLI:
    {
        "tenant_id": "personal",
        "cutoff_date": "2023-01-01",
        "max_emails_per_run": 500
    }

    CLI examples:
    # Daily sweep with default cutoff (365 days ago)
    airflow dags trigger lattice__retention_sweep

    # Specific account sweep
    airflow dags trigger lattice__retention_sweep \\
        --conf '{"tenant_id": "personal", "account_id": "personal-gmail"}'

    # Force rerun of completed sweep
    airflow dags trigger lattice__retention_sweep \\
        --conf '{"tenant_id": "personal", "cutoff_date": "2023-06-01", "force": true}'
"""

from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

from airflow import DAG
from airflow.decorators import task
from airflow.models.param import Param

# DAG default args
default_args = {
    "owner": "lattice",
    "depends_on_past": False,
    "email_on_failure": True,
    "email_on_retry": False,
    "retries": 3,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(minutes=30),
}


@task
def validate_params(params: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize sweep parameters."""
    import logging

    logger = logging.getLogger(__name__)

    tenant_id = params.get("tenant_id", "personal")
    account_id = params.get("account_id")  # Optional
    alias = params.get("alias")  # Optional
    cutoff_date_str = params.get("cutoff_date")
    max_emails = params.get("max_emails_per_run", 500)
    force = params.get("force", False)

    # Parse cutoff date (default: 365 days ago)
    if cutoff_date_str:
        # Support both YYYY-MM-DD and ISO8601 formats
        try:
            if "T" in cutoff_date_str:
                cutoff_date = datetime.fromisoformat(cutoff_date_str.replace("Z", "+00:00"))
            else:
                cutoff_date = datetime.strptime(cutoff_date_str, "%Y-%m-%d")
        except ValueError as e:
            msg = f"Invalid cutoff_date format: {cutoff_date_str}. Use YYYY-MM-DD."
            raise ValueError(msg) from e
    else:
        cutoff_date = datetime.now() - timedelta(days=365)

    # Validate max_emails bounds
    max_emails = max(1, min(int(max_emails), 5000))

    validated = {
        "tenant_id": tenant_id,
        "account_id": account_id,
        "alias": alias,
        "cutoff_date": cutoff_date.isoformat(),
        "max_emails_per_run": max_emails,
        "force": bool(force),
    }

    logger.info(
        "Validated retention sweep params: tenant=%s, cutoff=%s, max=%d, force=%s",
        tenant_id,
        cutoff_date.date().isoformat(),
        max_emails,
        force,
    )

    return validated


@task
def load_or_create_sweep_run(validated_params: dict[str, Any]) -> dict[str, Any]:
    """Load existing sweep run or create a new one (idempotent)."""
    import logging
    import os

    import psycopg

    logger = logging.getLogger(__name__)

    # Build connection string
    pg_host = os.getenv("POSTGRES_HOST", "localhost")
    pg_port = os.getenv("POSTGRES_PORT", "5432")
    pg_db = os.getenv("POSTGRES_DB", "lattice")
    pg_user = os.getenv("POSTGRES_USER", "lattice")
    pg_pass = os.getenv("POSTGRES_PASSWORD", "")

    conn_str = f"host={pg_host} port={pg_port} dbname={pg_db} user={pg_user} password={pg_pass}"

    tenant_id = validated_params["tenant_id"]
    account_id = validated_params.get("account_id")
    alias = validated_params.get("alias")
    cutoff_date = datetime.fromisoformat(validated_params["cutoff_date"])
    force = validated_params["force"]

    with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
        # Check for existing sweep with same parameters
        cur.execute(
            """
            SELECT id, status, emails_targeted, emails_published, last_email_id
            FROM retention_sweep_run
            WHERE tenant_id = %s
              AND cutoff_date = %s
              AND (account_id = %s OR (account_id IS NULL AND %s IS NULL))
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (tenant_id, cutoff_date, account_id, account_id),
        )
        existing = cur.fetchone()

        if existing:
            sweep_id, status, targeted, published, last_email_id = existing

            if status == "completed" and not force:
                logger.info(
                    "Sweep already completed: id=%s, targeted=%d, published=%d",
                    sweep_id,
                    targeted,
                    published,
                )
                return {
                    "sweep_id": str(sweep_id),
                    "status": "completed",
                    "is_resuming": False,
                    "skip_processing": True,
                    "emails_targeted": targeted,
                    "emails_published": published,
                    **validated_params,
                }

            if status == "running":
                logger.info(
                    "Resuming existing sweep: id=%s, last_email_id=%s, published=%d",
                    sweep_id,
                    last_email_id,
                    published,
                )
                return {
                    "sweep_id": str(sweep_id),
                    "status": "running",
                    "is_resuming": True,
                    "skip_processing": False,
                    "last_email_id": last_email_id,
                    "emails_targeted": targeted,
                    "emails_published": published,
                    **validated_params,
                }

            # status == "failed" or force == True: create new run
            logger.info("Previous sweep failed or force=True, creating new sweep")

        # Create new sweep run
        new_id = uuid4()
        cur.execute(
            """
            INSERT INTO retention_sweep_run (id, tenant_id, account_id, alias, cutoff_date, status)
            VALUES (%s, %s, %s, %s, %s, 'running')
            RETURNING id
            """,
            (new_id, tenant_id, account_id, alias, cutoff_date),
        )
        conn.commit()

        logger.info("Created new sweep run: id=%s", new_id)

        return {
            "sweep_id": str(new_id),
            "status": "running",
            "is_resuming": False,
            "skip_processing": False,
            "last_email_id": None,
            "emails_targeted": 0,
            "emails_published": 0,
            **validated_params,
        }


@task
def select_eligible_emails(sweep_run: dict[str, Any]) -> dict[str, Any]:
    """Select emails eligible for deletion based on cutoff date."""
    import logging
    import os

    import psycopg

    logger = logging.getLogger(__name__)

    if sweep_run.get("skip_processing"):
        logger.info("Skipping email selection - sweep already completed")
        return {**sweep_run, "eligible_emails": []}

    # Build connection string
    pg_host = os.getenv("POSTGRES_HOST", "localhost")
    pg_port = os.getenv("POSTGRES_PORT", "5432")
    pg_db = os.getenv("POSTGRES_DB", "lattice")
    pg_user = os.getenv("POSTGRES_USER", "lattice")
    pg_pass = os.getenv("POSTGRES_PASSWORD", "")

    conn_str = f"host={pg_host} port={pg_port} dbname={pg_db} user={pg_user} password={pg_pass}"

    tenant_id = sweep_run["tenant_id"]
    account_id = sweep_run.get("account_id")
    alias = sweep_run.get("alias")
    cutoff_date = datetime.fromisoformat(sweep_run["cutoff_date"])
    max_emails = sweep_run["max_emails_per_run"]
    last_email_id = sweep_run.get("last_email_id")

    with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
        # Build query with optional filters
        query = """
            SELECT e.id, e.tenant_id, e.account_id, e.provider_message_id
            FROM email e
            WHERE e.tenant_id = %s
              AND e.received_at < %s
              AND e.deletion_status = 'active'
              AND e.deleted_at IS NULL
        """
        params: list[Any] = [tenant_id, cutoff_date]

        if account_id:
            query += " AND e.account_id = %s"
            params.append(account_id)

        if alias:
            query += """
                AND EXISTS (
                    SELECT 1 FROM mail_accounts ma
                    WHERE ma.tenant_id = e.tenant_id
                      AND ma.account_id = e.account_id
                      AND ma.alias = %s
                )
            """
            params.append(alias)

        # Resume from checkpoint if resuming
        if last_email_id:
            query += " AND e.id > %s"
            params.append(last_email_id)

        # Order by ID for stable pagination and add limit
        query += " ORDER BY e.id LIMIT %s"
        params.append(max_emails)

        cur.execute(query, params)
        rows = cur.fetchall()

        eligible_emails = [
            {
                "email_id": str(row[0]),
                "tenant_id": row[1],
                "account_id": row[2],
                "provider_message_id": row[3],
            }
            for row in rows
        ]

        # Update targeted count in sweep run
        total_targeted = sweep_run.get("emails_targeted", 0) + len(eligible_emails)
        cur.execute(
            "UPDATE retention_sweep_run SET emails_targeted = %s WHERE id = %s",
            (total_targeted, sweep_run["sweep_id"]),
        )
        conn.commit()

        logger.info(
            "Selected %d eligible emails for deletion (cutoff=%s, tenant=%s)",
            len(eligible_emails),
            cutoff_date.date().isoformat(),
            tenant_id,
        )

        return {
            **sweep_run,
            "eligible_emails": eligible_emails,
            "emails_targeted": total_targeted,
        }


@task
def publish_delete_requests(sweep_data: dict[str, Any]) -> dict[str, Any]:
    """Publish deletion requests to Kafka."""
    import logging
    import os
    from datetime import datetime

    import psycopg

    logger = logging.getLogger(__name__)

    if sweep_data.get("skip_processing"):
        logger.info("Skipping publish - sweep already completed")
        return sweep_data

    eligible_emails = sweep_data.get("eligible_emails", [])
    if not eligible_emails:
        logger.info("No eligible emails to publish")
        return sweep_data

    # Import Kafka producer
    from lattice_kafka.producer import TOPIC_MAIL_DELETE, KafkaProducer

    # Build Postgres connection for checkpointing
    pg_host = os.getenv("POSTGRES_HOST", "localhost")
    pg_port = os.getenv("POSTGRES_PORT", "5432")
    pg_db = os.getenv("POSTGRES_DB", "lattice")
    pg_user = os.getenv("POSTGRES_USER", "lattice")
    pg_pass = os.getenv("POSTGRES_PASSWORD", "")
    conn_str = f"host={pg_host} port={pg_port} dbname={pg_db} user={pg_user} password={pg_pass}"

    producer = KafkaProducer()
    published_count = 0
    last_email_id = None
    cutoff_date = sweep_data["cutoff_date"]

    try:
        for email in eligible_emails:
            # Build deletion request payload
            request_id = str(uuid4())
            payload = {
                "request_id": request_id,
                "request_type": "single_email",
                "tenant_id": email["tenant_id"],
                "account_id": email["account_id"],
                "email_id": email["email_id"],
                "provider_message_id": email["provider_message_id"],
                "deletion_type": "hard",
                "deletion_reason": "retention_policy",
                "delete_vectors": True,
                "delete_storage": True,
                "delete_postgres": True,
                "cutoff_date": cutoff_date,
                "requested_at": datetime.utcnow().isoformat() + "Z",
            }

            # Headers without PII
            headers = {
                "tenant_id": email["tenant_id"],
                "account_id": email["account_id"],
                "reason": "retention_sweep",
            }

            # Publish with email_id as key for stable partitioning
            producer.publish(
                topic=TOPIC_MAIL_DELETE,
                key=email["email_id"],
                value=payload,
                headers=headers,
            )

            published_count += 1
            last_email_id = email["email_id"]

            # Checkpoint every 100 messages
            if published_count % 100 == 0:
                producer.flush()
                with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE retention_sweep_run
                        SET emails_published = emails_published + 100,
                            last_email_id = %s
                        WHERE id = %s
                        """,
                        (last_email_id, sweep_data["sweep_id"]),
                    )
                    conn.commit()
                logger.info("Checkpoint: published %d deletion requests", published_count)

        # Final flush
        producer.flush()

        # Update final count
        with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
            remaining = published_count % 100
            if remaining > 0:
                cur.execute(
                    """
                    UPDATE retention_sweep_run
                    SET emails_published = emails_published + %s,
                        last_email_id = %s
                    WHERE id = %s
                    """,
                    (remaining, last_email_id, sweep_data["sweep_id"]),
                )
                conn.commit()

        logger.info(
            "Published %d deletion requests to %s",
            published_count,
            TOPIC_MAIL_DELETE,
        )

        return {
            **sweep_data,
            "emails_published": sweep_data.get("emails_published", 0) + published_count,
            "last_email_id": last_email_id,
        }

    except Exception as e:
        logger.error("Failed to publish deletion requests: %s", str(e))
        # Mark sweep as failed
        with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
            cur.execute(
                """
                UPDATE retention_sweep_run
                SET status = 'failed', last_error = %s
                WHERE id = %s
                """,
                (str(e)[:500], sweep_data["sweep_id"]),
            )
            conn.commit()
        raise


@task
def update_sweep_status(sweep_result: dict[str, Any]) -> dict[str, Any]:
    """Update sweep run status to completed."""
    import logging
    import os
    from datetime import datetime

    import psycopg

    logger = logging.getLogger(__name__)

    if sweep_result.get("skip_processing"):
        logger.info("Sweep was already completed - no status update needed")
        return sweep_result

    # Build connection string
    pg_host = os.getenv("POSTGRES_HOST", "localhost")
    pg_port = os.getenv("POSTGRES_PORT", "5432")
    pg_db = os.getenv("POSTGRES_DB", "lattice")
    pg_user = os.getenv("POSTGRES_USER", "lattice")
    pg_pass = os.getenv("POSTGRES_PASSWORD", "")

    conn_str = f"host={pg_host} port={pg_port} dbname={pg_db} user={pg_user} password={pg_pass}"

    sweep_id = sweep_result["sweep_id"]
    emails_targeted = sweep_result.get("emails_targeted", 0)
    emails_published = sweep_result.get("emails_published", 0)

    with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE retention_sweep_run
            SET status = 'completed',
                completed_at = %s,
                emails_targeted = %s,
                emails_published = %s
            WHERE id = %s
            """,
            (datetime.utcnow(), emails_targeted, emails_published, sweep_id),
        )
        conn.commit()

    logger.info(
        "Retention sweep completed: sweep_id=%s, targeted=%d, published=%d",
        sweep_id,
        emails_targeted,
        emails_published,
    )

    return {
        "sweep_id": sweep_id,
        "status": "completed",
        "tenant_id": sweep_result["tenant_id"],
        "cutoff_date": sweep_result["cutoff_date"],
        "emails_targeted": emails_targeted,
        "emails_published": emails_published,
    }


# DAG definition
with DAG(
    dag_id="lattice__retention_sweep",
    description="Retention policy sweep - identifies and queues emails for deletion",
    default_args=default_args,
    schedule="@daily",
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=1,
    tags=["lattice", "mail", "retention", "lifecycle"],
    params={
        "tenant_id": Param(
            default="personal",
            type="string",
            description="Tenant ID to sweep",
        ),
        "account_id": Param(
            default=None,
            type=["string", "null"],
            description="Optional: specific account ID to sweep",
        ),
        "alias": Param(
            default=None,
            type=["string", "null"],
            description="Optional: specific alias to sweep",
        ),
        "cutoff_date": Param(
            default=None,
            type=["string", "null"],
            description="Cutoff date (YYYY-MM-DD or ISO8601). Default: 365 days ago",
        ),
        "max_emails_per_run": Param(
            default=500,
            type="integer",
            description="Maximum emails to process per run",
            minimum=1,
            maximum=5000,
        ),
        "force": Param(
            default=False,
            type="boolean",
            description="Force rerun even if sweep already completed",
        ),
    },
    render_template_as_native_obj=True,
) as dag:
    # Task flow
    validated = validate_params(params="{{ params }}")
    sweep_run = load_or_create_sweep_run(validated_params=validated)
    emails = select_eligible_emails(sweep_run=sweep_run)
    published = publish_delete_requests(sweep_data=emails)
    final = update_sweep_status(sweep_result=published)

    # Explicit dependencies
    validated >> sweep_run >> emails >> published >> final
