"""
Lattice Gmail Sync Incremental DAG

Orchestrates incremental email sync from Gmail accounts.
Runs every 10 minutes, fetching new messages via Gmail History API.

After successful store + publish:
- Applies 'Lattice/<alias>' label to the message
- Updates watermark (historyId) for next run
"""

from datetime import datetime, timedelta
from typing import Any

from airflow import DAG
from airflow.decorators import task

# DAG default args with retry policy
default_args = {
    "owner": "lattice",
    "depends_on_past": False,
    "email_on_failure": False,
    "email_on_retry": False,
    "retries": 3,
    "retry_delay": timedelta(minutes=2),
    "execution_timeout": timedelta(minutes=15),
}


@task
def load_gmail_accounts() -> list[dict[str, Any]]:
    """Load enabled Gmail accounts from Postgres."""
    from lattice_mail_tasks import load_enabled_accounts

    accounts = load_enabled_accounts(provider="gmail")
    return accounts


@task
def sync_gmail_account(account: dict[str, Any], max_messages: int = 100) -> dict[str, Any]:
    """
    Process a single Gmail account incrementally.

    Returns sync results including counts and any errors.
    """
    from lattice_mail_tasks import process_gmail_account_incremental

    result = process_gmail_account_incremental(
        tenant_id=account["tenant_id"],
        account_id=account["account_id"],
        alias=account["alias"],
        max_messages=max_messages,
    )

    return {
        "account_id": result.account_id,
        "alias": result.alias,
        "messages_fetched": result.messages_fetched,
        "messages_stored": result.messages_stored,
        "messages_published": result.messages_published,
        "messages_post_processed": result.messages_post_processed,
        "errors": result.errors,
        "watermark_updated": result.watermark_updated,
    }


@task
def summarize_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize sync results across all accounts."""
    total_fetched = sum(r["messages_fetched"] for r in results)
    total_published = sum(r["messages_published"] for r in results)
    total_errors = sum(len(r["errors"]) for r in results)

    return {
        "accounts_processed": len(results),
        "total_fetched": total_fetched,
        "total_published": total_published,
        "total_errors": total_errors,
    }


with DAG(
    dag_id="lattice__gmail_sync_incremental",
    description="Incremental Gmail sync - fetches new messages and publishes to Kafka",
    default_args=default_args,
    schedule="*/10 * * * *",  # Every 10 minutes
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=1,
    tags=["lattice", "mail", "sync", "gmail", "incremental"],
    params={
        "max_messages": 100,
    },
) as dag:
    # Load accounts
    accounts = load_gmail_accounts()

    # Dynamic task mapping: process each account in parallel
    sync_results = sync_gmail_account.expand(account=accounts)

    # Summarize results
    summary = summarize_results(sync_results)
