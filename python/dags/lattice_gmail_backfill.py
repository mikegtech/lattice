"""
Lattice Gmail Backfill DAG

Backfills historical Gmail messages within a specified date range.
Manually triggered with parameters for tenant_id, account_id, start_date, end_date.

Features:
- Date-controllable backfill windows
- Rate limiting via limit_per_run parameter
- Idempotent: skips messages already labeled with 'Lattice/<alias>'
- Supports bounded fetch windows for resumable processing

Usage:
    Trigger via Airflow UI or CLI with parameters:
    {
        "tenant_id": "personal",
        "account_id": "personal-gmail",
        "start_date": "2024-01-01",
        "end_date": "2024-01-31",
        "limit_per_run": 100
    }

    CLI example:
    airflow dags trigger lattice__gmail_backfill --conf '{"tenant_id": "personal", ...}'
"""

from datetime import datetime, timedelta
from typing import Any

from airflow import DAG
from airflow.decorators import task
from airflow.models.param import Param

# DAG default args with extended retry policy for backfill
default_args = {
    "owner": "lattice",
    "depends_on_past": False,
    "email_on_failure": True,
    "email_on_retry": False,
    "retries": 5,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(hours=2),
}


@task
def validate_params(params: dict[str, Any]) -> dict[str, Any]:
    """Validate and parse backfill parameters."""
    tenant_id = params.get("tenant_id")
    account_id = params.get("account_id")
    start_date_str = params.get("start_date")
    end_date_str = params.get("end_date")
    limit_per_run = params.get("limit_per_run", 100)

    if not all([tenant_id, account_id, start_date_str, end_date_str]):
        raise ValueError("Missing required parameters: tenant_id, account_id, start_date, end_date")

    start_date = datetime.strptime(start_date_str, "%Y-%m-%d")
    end_date = datetime.strptime(end_date_str, "%Y-%m-%d")

    if start_date >= end_date:
        raise ValueError("start_date must be before end_date")

    return {
        "tenant_id": tenant_id,
        "account_id": account_id,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "limit_per_run": limit_per_run,
    }


@task
def load_account(tenant_id: str, account_id: str) -> dict[str, Any]:
    """Load account details from Postgres."""
    from lattice_mail.account_registry import AccountRegistry, PostgresConfig

    pg_config = PostgresConfig.from_env()
    registry = AccountRegistry(pg_config)

    account = registry.get_account(tenant_id, account_id)
    if not account:
        raise ValueError(f"Account not found: {tenant_id}/{account_id}")

    if account.provider != "gmail":
        raise ValueError(f"Account is not Gmail: {account.provider}")

    return {
        "tenant_id": account.tenant_id,
        "account_id": account.account_id,
        "alias": account.alias,
        "provider": account.provider,
    }


@task
def run_backfill(
    account: dict[str, Any],
    validated_params: dict[str, Any],
) -> dict[str, Any]:
    """Run the Gmail backfill for the specified date range."""
    from lattice_mail_tasks import process_gmail_backfill

    start_date = datetime.fromisoformat(validated_params["start_date"])
    end_date = datetime.fromisoformat(validated_params["end_date"])

    result = process_gmail_backfill(
        tenant_id=account["tenant_id"],
        account_id=account["account_id"],
        alias=account["alias"],
        start_date=start_date,
        end_date=end_date,
        limit_per_run=validated_params["limit_per_run"],
    )

    return {
        "account_id": result.account_id,
        "alias": result.alias,
        "messages_fetched": result.messages_fetched,
        "messages_stored": result.messages_stored,
        "messages_published": result.messages_published,
        "messages_post_processed": result.messages_post_processed,
        "errors": result.errors,
        "start_date": validated_params["start_date"],
        "end_date": validated_params["end_date"],
    }


@task
def log_completion(result: dict[str, Any]) -> None:
    """Log backfill completion."""
    import logging

    logger = logging.getLogger(__name__)
    logger.info(
        "Gmail backfill complete for %s/%s: "
        "%d fetched, %d stored, %d published, %d labeled. "
        "Date range: %s to %s. Errors: %d",
        result["account_id"],
        result["alias"],
        result["messages_fetched"],
        result["messages_stored"],
        result["messages_published"],
        result["messages_post_processed"],
        result["start_date"],
        result["end_date"],
        len(result["errors"]),
    )


with DAG(
    dag_id="lattice__gmail_backfill",
    description="Gmail mailbox backfill - fetches historical messages by date range",
    default_args=default_args,
    schedule=None,  # Manual trigger only
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=1,
    tags=["lattice", "mail", "backfill", "gmail"],
    params={
        "tenant_id": Param(
            default="personal",
            type="string",
            description="Tenant ID",
        ),
        "account_id": Param(
            default="personal-gmail",
            type="string",
            description="Account ID (must be Gmail provider)",
        ),
        "start_date": Param(
            default="2024-01-01",
            type="string",
            description="Start date (YYYY-MM-DD)",
        ),
        "end_date": Param(
            default="2024-01-31",
            type="string",
            description="End date (YYYY-MM-DD)",
        ),
        "limit_per_run": Param(
            default=100,
            type="integer",
            description="Maximum messages to process per run",
            minimum=1,
            maximum=500,
        ),
    },
    render_template_as_native_obj=True,
) as dag:
    # Validate parameters
    validated = validate_params(params="{{ params }}")

    # Load account details
    account = load_account(
        tenant_id="{{ params.tenant_id }}",
        account_id="{{ params.account_id }}",
    )

    # Run backfill
    result = run_backfill(account=account, validated_params=validated)

    # Log completion
    log_completion(result)

    # Dependencies
    validated >> account >> result
