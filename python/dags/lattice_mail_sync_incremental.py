"""
Lattice Mail Sync Incremental DAG

Orchestrates incremental email sync from Gmail to Kafka.
This DAG fetches new emails since the last sync and publishes raw events.

Schedule: Every 5 minutes
"""

from datetime import datetime, timedelta
from typing import Any

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.postgres.hooks.postgres import PostgresHook

# DAG default args with retry policy
default_args = {
    "owner": "lattice",
    "depends_on_past": False,
    "email_on_failure": False,
    "email_on_retry": False,
    "retries": 3,
    "retry_delay": timedelta(minutes=2),
    "execution_timeout": timedelta(minutes=10),
}


def get_sync_state(account_id: str, **context: Any) -> dict[str, Any]:
    """Fetch current sync state from Postgres."""
    hook = PostgresHook(postgres_conn_id="lattice_postgres")

    result = hook.get_first(
        """
        SELECT history_id, last_sync_at, status
        FROM sync_state
        WHERE account_id = %s
        """,
        parameters=(account_id,),
    )

    if result:
        return {
            "history_id": result[0],
            "last_sync_at": result[1].isoformat() if result[1] else None,
            "status": result[2],
        }

    return {"history_id": None, "last_sync_at": None, "status": "new"}


def fetch_gmail_messages(account_id: str, history_id: str | None, **context: Any) -> list[dict]:
    """
    Fetch new messages from Gmail API.

    STUB: In production, this would use the Gmail API to fetch messages
    since the given history_id.
    """
    # TODO: Implement actual Gmail API integration
    # This is a stub that returns empty list
    context["ti"].xcom_push(key="message_count", value=0)
    context["ti"].xcom_push(key="new_history_id", value=history_id or "initial")
    return []


def publish_raw_events(messages: list[dict], account_id: str, **context: Any) -> int:
    """
    Publish raw email events to Kafka.

    STUB: In production, this would publish to lattice.mail.raw.v1
    """
    # TODO: Implement Kafka producer
    # For now, just return the count
    return len(messages) if isinstance(messages, list) else 0


def update_sync_state(account_id: str, history_id: str, message_count: int, **context: Any) -> None:
    """Update sync state in Postgres after successful sync."""
    hook = PostgresHook(postgres_conn_id="lattice_postgres")

    hook.run(
        """
        INSERT INTO sync_state (
            tenant_id, account_id, history_id, last_sync_at, last_message_count, status
        )
        VALUES ('default', %s, %s, NOW(), %s, 'idle')
        ON CONFLICT (tenant_id, account_id)
        DO UPDATE SET
            history_id = EXCLUDED.history_id,
            last_sync_at = NOW(),
            last_message_count = EXCLUDED.last_message_count,
            status = 'idle',
            updated_at = NOW()
        """,
        parameters=(account_id, history_id, message_count),
    )


def emit_audit_event(event_type: str, details: dict, **context: Any) -> None:
    """Emit audit event to Kafka audit topic."""
    # TODO: Implement audit event emission
    pass


with DAG(
    dag_id="lattice__mail_sync_incremental",
    description="Incremental Gmail sync - fetches new messages and publishes to Kafka",
    default_args=default_args,
    schedule_interval="*/5 * * * *",  # Every 5 minutes
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=1,
    tags=["lattice", "mail", "sync", "gmail"],
) as dag:
    # In production, this would iterate over multiple accounts
    # For now, using a single account from Airflow Variables
    account_id = "{{ var.value.get('lattice_gmail_account', 'stub@example.com') }}"

    get_state = PythonOperator(
        task_id="get_sync_state",
        python_callable=get_sync_state,
        op_kwargs={"account_id": account_id},
    )

    fetch_messages = PythonOperator(
        task_id="fetch_gmail_messages",
        python_callable=fetch_gmail_messages,
        op_kwargs={
            "account_id": account_id,
            "history_id": "{{ ti.xcom_pull(task_ids='get_sync_state')['history_id'] }}",
        },
    )

    publish_events = PythonOperator(
        task_id="publish_raw_events",
        python_callable=publish_raw_events,
        op_kwargs={
            "messages": "{{ ti.xcom_pull(task_ids='fetch_gmail_messages') }}",
            "account_id": account_id,
        },
    )

    update_state = PythonOperator(
        task_id="update_sync_state",
        python_callable=update_sync_state,
        op_kwargs={
            "account_id": account_id,
            "history_id": (
                "{{ ti.xcom_pull(task_ids='fetch_gmail_messages', key='new_history_id') or '' }}"
            ),
            "message_count": (
                "{{ ti.xcom_pull(task_ids='fetch_gmail_messages', key='message_count') or 0 }}"
            ),
        },
    )

    audit_complete = PythonOperator(
        task_id="emit_audit_event",
        python_callable=emit_audit_event,
        op_kwargs={
            "event_type": "sync.completed",
            "details": {
                "account_id": account_id,
                "message_count": "{{ ti.xcom_pull(task_ids='publish_raw_events') }}",
            },
        },
    )

    # Task dependencies
    get_state >> fetch_messages >> publish_events >> update_state >> audit_complete
