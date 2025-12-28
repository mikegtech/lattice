"""
Lattice Retention Sweep DAG

Identifies emails eligible for deletion based on retention policy and publishes
deletion requests to Kafka for the mail-deleter worker to execute.

Key design:
- Airflow orchestrates ONLY - no direct deletion of data
- Tuple-based cursor (received_at, id) for stable pagination
- Idempotent: skips completed sweeps unless force=true
- Resumable: continues from last checkpoint on rerun

Usage:
    airflow dags trigger lattice__retention_sweep

    airflow dags trigger lattice__retention_sweep \
        --conf '{"tenant_id": "personal", "account_id": "personal-gmail"}'

    airflow dags trigger lattice__retention_sweep \
        --conf '{"cutoff_date": "2023-06-01", "force": true}'
"""

from datetime import datetime, timedelta
from typing import Any

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


def _get_postgres_connection_string() -> str:
    """Get Postgres connection string using PostgresConfig from lattice_mail."""
    from lattice_mail.account_registry import PostgresConfig

    config = PostgresConfig.from_env()
    return config.connection_string


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

    # Log without PII - counts and identifiers only
    logger.info(
        "Validated params: tenant=%s, account=%s, alias=%s, cutoff=%s, max=%d, force=%s",
        tenant_id,
        account_id or "(all)",
        alias or "(all)",
        cutoff_date.date().isoformat(),
        max_emails,
        force,
    )

    return validated


@task
def load_or_create_sweep_run(validated_params: dict[str, Any]) -> dict[str, Any]:
    """Load existing sweep run or create a new one (idempotent)."""
    import logging
    from uuid import uuid4

    import psycopg

    logger = logging.getLogger(__name__)
    conn_str = _get_postgres_connection_string()

    tenant_id = validated_params["tenant_id"]
    account_id = validated_params.get("account_id")
    alias = validated_params.get("alias")
    cutoff_date = datetime.fromisoformat(validated_params["cutoff_date"])
    force = validated_params["force"]

    with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
        # Check for existing sweep with same parameters (NULL-safe comparison)
        cur.execute(
            """
            SELECT id, status, emails_targeted, emails_published,
                   last_received_at, last_email_id
            FROM retention_sweep_run
            WHERE tenant_id = %s
              AND cutoff_date = %s
              AND COALESCE(account_id, '') = COALESCE(%s, '')
              AND COALESCE(alias, '') = COALESCE(%s, '')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (tenant_id, cutoff_date, account_id, alias),
        )
        existing = cur.fetchone()

        if existing:
            (
                sweep_id,
                status,
                targeted,
                published,
                last_received_at,
                last_email_id,
            ) = existing

            if status == "completed" and not force:
                logger.info(
                    "Sweep already completed: id=%s, published=%d",
                    sweep_id,
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
                    "Resuming sweep: id=%s, published=%d, has_cursor=%s",
                    sweep_id,
                    published,
                    last_received_at is not None,
                )
                return {
                    "sweep_id": str(sweep_id),
                    "status": "running",
                    "is_resuming": True,
                    "skip_processing": False,
                    "last_received_at": (
                        last_received_at.isoformat() if last_received_at else None
                    ),
                    "last_email_id": str(last_email_id) if last_email_id else None,
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
            INSERT INTO retention_sweep_run
                (id, tenant_id, account_id, alias, cutoff_date, status)
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
            "last_received_at": None,
            "last_email_id": None,
            "emails_targeted": 0,
            "emails_published": 0,
            **validated_params,
        }


@task
def select_eligible_emails(sweep_run: dict[str, Any]) -> dict[str, Any]:
    """Select emails eligible for deletion using tuple-based cursor."""
    import logging

    import psycopg

    logger = logging.getLogger(__name__)

    if sweep_run.get("skip_processing"):
        logger.info("Skipping email selection - sweep already completed")
        return {**sweep_run, "eligible_emails": [], "batch_complete": True}

    conn_str = _get_postgres_connection_string()

    tenant_id = sweep_run["tenant_id"]
    account_id = sweep_run.get("account_id")
    alias = sweep_run.get("alias")
    cutoff_date = datetime.fromisoformat(sweep_run["cutoff_date"])
    max_emails = sweep_run["max_emails_per_run"]
    last_received_at = sweep_run.get("last_received_at")
    last_email_id = sweep_run.get("last_email_id")

    with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
        # Build query with tuple-based cursor for stable pagination
        query = """
            SELECT e.id, e.tenant_id, e.account_id, e.received_at
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

        # Resume from cursor using tuple comparison (received_at, id)
        if last_received_at and last_email_id:
            query += " AND (e.received_at, e.id) > (%s, %s)"
            cursor_ts = datetime.fromisoformat(last_received_at)
            params.extend([cursor_ts, last_email_id])

        # Order by tuple for stable pagination and add limit
        query += " ORDER BY e.received_at, e.id LIMIT %s"
        params.append(max_emails)

        cur.execute(query, params)
        rows = cur.fetchall()

        # Build result without PII (no provider_message_id, subject, addresses)
        eligible_emails = [
            {
                "email_id": str(row[0]),
                "tenant_id": row[1],
                "account_id": row[2],
                "received_at": row[3].isoformat(),
            }
            for row in rows
        ]

        selected_count = len(eligible_emails)

        # Update targeted count in sweep run
        total_targeted = sweep_run.get("emails_targeted", 0) + selected_count
        cur.execute(
            "UPDATE retention_sweep_run SET emails_targeted = %s WHERE id = %s",
            (total_targeted, sweep_run["sweep_id"]),
        )
        conn.commit()

        # Determine if this batch completes the sweep
        # Batch is complete (sweep should be marked completed) only if:
        # - No emails found, OR
        # - Fewer emails than max_emails_per_run (no more to process)
        batch_complete = selected_count < max_emails

        logger.info(
            "Selected %d emails (cutoff=%s, batch_complete=%s)",
            selected_count,
            cutoff_date.date().isoformat(),
            batch_complete,
        )

        return {
            **sweep_run,
            "eligible_emails": eligible_emails,
            "emails_targeted": total_targeted,
            "batch_complete": batch_complete,
        }


@task
def publish_delete_requests(sweep_data: dict[str, Any]) -> dict[str, Any]:
    """Publish deletion requests to Kafka with checkpointing."""
    import logging
    from datetime import datetime
    from uuid import uuid4

    import psycopg

    logger = logging.getLogger(__name__)

    if sweep_data.get("skip_processing"):
        logger.info("Skipping publish - sweep already completed")
        return sweep_data

    eligible_emails = sweep_data.get("eligible_emails", [])
    if not eligible_emails:
        logger.info("No eligible emails to publish")
        return sweep_data

    from lattice_kafka.producer import TOPIC_MAIL_DELETE, KafkaProducer

    conn_str = _get_postgres_connection_string()
    producer = KafkaProducer()

    published_count = 0
    last_published_received_at = None
    last_published_email_id = None
    cutoff_date = sweep_data["cutoff_date"]
    sweep_id = sweep_data["sweep_id"]

    try:
        for email in eligible_emails:
            # Build deletion request payload
            # Note: tenant_id and account_id are required in BOTH the envelope AND payload
            # The envelope has them for routing, the payload has them for worker validation
            request_id = str(uuid4())
            payload = {
                "request_id": request_id,
                "request_type": "single_email",
                "tenant_id": email["tenant_id"],
                "account_id": email["account_id"],
                "email_id": email["email_id"],
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
                "x-lattice-reason": "retention_sweep",
            }

            # Publish with envelope wrapper for TypeScript worker compatibility
            producer.publish_envelope(
                topic=TOPIC_MAIL_DELETE,
                key=email["email_id"],
                payload=payload,
                tenant_id=email["tenant_id"],
                account_id=email["account_id"],
                domain="mail",
                stage="delete",
                source_service="retention-sweep",
                source_version="1.0.0",
                schema_version="v1",
                data_classification="confidential",
                contains_pii=False,
                headers=headers,
            )

            published_count += 1
            last_published_received_at = email["received_at"]
            last_published_email_id = email["email_id"]

            # Checkpoint every 100 messages with tuple cursor
            if published_count % 100 == 0:
                producer.flush()
                with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE retention_sweep_run
                        SET emails_published = emails_published + 100,
                            last_received_at = %s,
                            last_email_id = %s
                        WHERE id = %s
                        """,
                        (
                            datetime.fromisoformat(last_published_received_at),
                            last_published_email_id,
                            sweep_id,
                        ),
                    )
                    conn.commit()
                logger.info("Checkpoint: published %d requests", published_count)

        # Final flush
        producer.flush()

        # Update final count and cursor
        with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
            remaining = published_count % 100
            if remaining > 0:
                cur.execute(
                    """
                    UPDATE retention_sweep_run
                    SET emails_published = emails_published + %s,
                        last_received_at = %s,
                        last_email_id = %s
                    WHERE id = %s
                    """,
                    (
                        remaining,
                        datetime.fromisoformat(last_published_received_at),
                        last_published_email_id,
                        sweep_id,
                    ),
                )
                conn.commit()

        logger.info("Published %d deletion requests", published_count)

        return {
            **sweep_data,
            "emails_published": sweep_data.get("emails_published", 0) + published_count,
            "last_received_at": last_published_received_at,
            "last_email_id": last_published_email_id,
        }

    except Exception as e:
        error_msg = str(e)[:500]
        logger.error("Failed to publish deletion requests: %s", error_msg)

        # Mark sweep as failed - do not advance cursor beyond last successful publish
        with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
            cur.execute(
                """
                UPDATE retention_sweep_run
                SET status = 'failed', last_error = %s
                WHERE id = %s
                """,
                (error_msg, sweep_id),
            )
            conn.commit()
        raise


@task
def update_sweep_status(sweep_result: dict[str, Any]) -> dict[str, Any]:
    """Update sweep run status based on completion logic."""
    import logging
    from datetime import datetime

    import psycopg

    logger = logging.getLogger(__name__)

    if sweep_result.get("skip_processing"):
        logger.info("Sweep was already completed - no status update needed")
        return sweep_result

    conn_str = _get_postgres_connection_string()
    sweep_id = sweep_result["sweep_id"]
    emails_targeted = sweep_result.get("emails_targeted", 0)
    emails_published = sweep_result.get("emails_published", 0)
    batch_complete = sweep_result.get("batch_complete", False)

    with psycopg.connect(conn_str) as conn, conn.cursor() as cur:
        if batch_complete:
            # Mark as completed - no more emails to process
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
            final_status = "completed"
            logger.info(
                "Sweep completed: id=%s, targeted=%d, published=%d",
                sweep_id,
                emails_targeted,
                emails_published,
            )
        else:
            # Keep as running - more emails to process in next run
            cur.execute(
                """
                UPDATE retention_sweep_run
                SET emails_targeted = %s,
                    emails_published = %s
                WHERE id = %s
                """,
                (emails_targeted, emails_published, sweep_id),
            )
            final_status = "running"
            logger.info(
                "Sweep batch done (more remain): id=%s, targeted=%d, published=%d",
                sweep_id,
                emails_targeted,
                emails_published,
            )

        conn.commit()

    return {
        "sweep_id": sweep_id,
        "status": final_status,
        "tenant_id": sweep_result["tenant_id"],
        "cutoff_date": sweep_result["cutoff_date"],
        "emails_targeted": emails_targeted,
        "emails_published": emails_published,
        "batch_complete": batch_complete,
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
