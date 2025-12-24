"""
Lattice Mail Backfill DAG

Orchestrates full mailbox backfill from Gmail to Kafka.
This DAG fetches all historical emails in batches.

Schedule: Manual trigger only
"""

from datetime import datetime, timedelta
from typing import Any

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.postgres.hooks.postgres import PostgresHook

# DAG default args with extended retry policy for backfill
default_args = {
    "owner": "lattice",
    "depends_on_past": False,
    "email_on_failure": True,
    "email_on_retry": False,
    "retries": 5,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(hours=4),
}

# Batch size for backfill operations
BATCH_SIZE = 100
MAX_MESSAGES = 10000  # Safety limit per run


def init_backfill(account_id: str, **context: Any) -> dict[str, Any]:
    """Initialize backfill state and mark as in progress."""
    hook = PostgresHook(postgres_conn_id="lattice_postgres")

    # Update sync state to indicate backfill in progress
    hook.run(
        """
        INSERT INTO sync_state (tenant_id, account_id, status)
        VALUES ('default', %s, 'syncing')
        ON CONFLICT (tenant_id, account_id)
        DO UPDATE SET status = 'syncing', updated_at = NOW()
        """,
        parameters=(account_id,),
    )

    return {
        "account_id": account_id,
        "batch_size": BATCH_SIZE,
        "max_messages": MAX_MESSAGES,
        "started_at": datetime.utcnow().isoformat(),
    }


def list_all_messages(account_id: str, page_token: str | None = None, **context: Any) -> dict:
    """
    List all message IDs from Gmail.

    STUB: In production, this would paginate through all messages.
    """
    # TODO: Implement Gmail API list messages
    return {
        "message_ids": [],
        "next_page_token": None,
        "total_count": 0,
    }


def fetch_message_batch(account_id: str, message_ids: list[str], **context: Any) -> list[dict]:
    """
    Fetch a batch of full message payloads.

    STUB: In production, this would use Gmail API batch get.
    """
    # TODO: Implement Gmail API batch get
    return []


def publish_batch(messages: list[dict], account_id: str, **context: Any) -> int:
    """Publish batch of raw events to Kafka."""
    # TODO: Implement Kafka batch producer
    return len(messages) if isinstance(messages, list) else 0


def finalize_backfill(account_id: str, total_count: int, **context: Any) -> None:
    """Mark backfill as complete and update sync state."""
    hook = PostgresHook(postgres_conn_id="lattice_postgres")

    hook.run(
        """
        UPDATE sync_state
        SET status = 'idle',
            last_sync_at = NOW(),
            last_message_count = %s,
            updated_at = NOW()
        WHERE account_id = %s
        """,
        parameters=(total_count, account_id),
    )


def emit_audit_event(event_type: str, details: dict, **context: Any) -> None:
    """Emit audit event."""
    # TODO: Implement audit emission
    pass


with DAG(
    dag_id="lattice__mail_backfill",
    description="Full Gmail mailbox backfill - fetches all historical messages",
    default_args=default_args,
    schedule_interval=None,  # Manual trigger only
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=1,
    tags=["lattice", "mail", "backfill", "gmail"],
    params={
        "account_id": "stub@example.com",
        "max_messages": MAX_MESSAGES,
    },
) as dag:
    account_id = "{{ params.account_id }}"

    init = PythonOperator(
        task_id="init_backfill",
        python_callable=init_backfill,
        op_kwargs={"account_id": account_id},
    )

    audit_start = PythonOperator(
        task_id="emit_backfill_started",
        python_callable=emit_audit_event,
        op_kwargs={
            "event_type": "backfill.started",
            "details": {"account_id": account_id},
        },
    )

    list_messages = PythonOperator(
        task_id="list_all_messages",
        python_callable=list_all_messages,
        op_kwargs={"account_id": account_id},
    )

    # In a full implementation, this would be a dynamic task group
    # that processes batches in parallel with rate limiting
    fetch_batch = PythonOperator(
        task_id="fetch_message_batch",
        python_callable=fetch_message_batch,
        op_kwargs={
            "account_id": account_id,
            "message_ids": "{{ ti.xcom_pull(task_ids='list_all_messages')['message_ids'][:100] }}",
        },
    )

    publish = PythonOperator(
        task_id="publish_batch",
        python_callable=publish_batch,
        op_kwargs={
            "messages": "{{ ti.xcom_pull(task_ids='fetch_message_batch') }}",
            "account_id": account_id,
        },
    )

    finalize = PythonOperator(
        task_id="finalize_backfill",
        python_callable=finalize_backfill,
        op_kwargs={
            "account_id": account_id,
            "total_count": "{{ ti.xcom_pull(task_ids='list_all_messages')['total_count'] }}",
        },
    )

    audit_complete = PythonOperator(
        task_id="emit_backfill_completed",
        python_callable=emit_audit_event,
        op_kwargs={
            "event_type": "backfill.completed",
            "details": {
                "account_id": account_id,
                "total_count": "{{ ti.xcom_pull(task_ids='list_all_messages')['total_count'] }}",
            },
        },
    )

    # Task dependencies
    init >> audit_start >> list_messages >> fetch_batch >> publish >> finalize >> audit_complete
