"""
Lattice Gmail Backfill DAG - Catchup-Based Sequential Processing
=================================================================
Backfills Gmail messages day-by-day using Airflow's catchup mechanism.

Architecture:
- Uses execution_date to determine which day to process
- Loops internally until ALL messages for that day are processed (batch size: 100)
- Idempotency via Gmail labels (skips already-labeled messages)
- Sequential processing via depends_on_past=True

Usage:
1. Set Airflow Variables for account configuration:
   - lattice_gmail_tenant_id (default: personal)
   - lattice_gmail_account_id (default: personal-gmail)
   - lattice_gmail_alias (default: inbox)

2. Set start_date and end_date to define backfill window

3. Unpause the DAG - Airflow will create runs for each day

4. Monitor progress in Airflow UI

5. Pause when complete or adjust end_date to extend

Configuration (via Airflow Variables):
- lattice_gmail_tenant_id: Tenant identifier
- lattice_gmail_account_id: Account identifier
- lattice_gmail_alias: Label alias (e.g., 'inbox')

Configuration (via environment for credentials):
- GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER_EMAIL

Design Properties:
- Idempotent: Already-labeled messages are excluded from query
- Resumable: If a run fails mid-batch, re-run processes remaining messages
- Sequential: depends_on_past ensures Day N waits for Day N-1
- Observable: Detailed logging without PII exposure
"""

from datetime import datetime, timedelta

from airflow import DAG
from airflow.models import Variable
from airflow.operators.python import PythonOperator

# Import shared task functions
from lattice_mail_tasks import gmail_backfill_day_task

# =============================================================================
# CONFIGURATION
# =============================================================================

# Account configuration - set via Airflow Variables or use defaults
# Set via CLI:
#   airflow variables set lattice_gmail_tenant_id personal
#   airflow variables set lattice_gmail_account_id personal-gmail
#   airflow variables set lattice_gmail_alias inbox
GMAIL_TENANT_ID = Variable.get("lattice_gmail_tenant_id", default_var="personal")
GMAIL_ACCOUNT_ID = Variable.get("lattice_gmail_account_id", default_var="personal-gmail")
GMAIL_ALIAS = Variable.get("lattice_gmail_alias", default_var="inbox")

# Backfill window - adjust these to control what gets processed
BACKFILL_START_DATE = datetime(2024, 4, 1)
BACKFILL_END_DATE = datetime(2024, 4, 30)

# Processing settings
BATCH_SIZE = 100  # Messages per internal loop iteration
MAX_BATCHES_PER_RUN = None  # None = unlimited (process all messages for the day)

default_args = {
    "owner": "lattice",
    "depends_on_past": True,  # CRITICAL: Wait for previous day to complete
    "wait_for_downstream": True,
    "retries": 3,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(hours=2),
    "email_on_failure": False,
    "email_on_retry": False,
}


# =============================================================================
# DAG DEFINITION
# =============================================================================

dag = DAG(
    "lattice__gmail_backfill",
    default_args=default_args,
    description="Backfill Gmail messages day-by-day with catchup processing",
    schedule_interval="@daily",
    start_date=BACKFILL_START_DATE,
    end_date=BACKFILL_END_DATE,
    max_active_runs=1,  # CRITICAL: Only one day at a time
    catchup=True,
    tags=["lattice", "gmail", "backfill", "mail-ingestion"],
)


# =============================================================================
# TASK DEFINITIONS
# =============================================================================


def run_backfill_for_account(**context):
    """
    Process ALL Gmail messages for a single day (derived from execution_date).

    Loops internally with BATCH_SIZE until no more messages remain.
    Uses account configuration from Airflow Variables.
    """
    execution_date = context["execution_date"]

    # Log configuration for debugging
    import logging

    logger = logging.getLogger(__name__)
    logger.info(f"Gmail backfill starting for {execution_date.date()}")
    logger.info(
        f"Account config: tenant={GMAIL_TENANT_ID}, account={GMAIL_ACCOUNT_ID}, alias={GMAIL_ALIAS}"
    )

    # Run backfill for configured account
    result = gmail_backfill_day_task(
        execution_date=execution_date,
        tenant_id=GMAIL_TENANT_ID,
        account_id=GMAIL_ACCOUNT_ID,
        alias=GMAIL_ALIAS,
        batch_size=BATCH_SIZE,
        max_batches=MAX_BATCHES_PER_RUN,
    )

    return {
        "date": str(execution_date.date()),
        "tenant_id": GMAIL_TENANT_ID,
        "account_id": GMAIL_ACCOUNT_ID,
        "alias": GMAIL_ALIAS,
        "messages_fetched": result.get("messages_fetched", 0),
        "messages_stored": result.get("messages_stored", 0),
        "messages_published": result.get("messages_published", 0),
        "messages_labeled": result.get("messages_labeled", 0),
        "batches_processed": result.get("batches_processed", 0),
        "errors": result.get("errors", []),
    }


# =============================================================================
# TASK INSTANCES
# =============================================================================

t_run_backfill = PythonOperator(
    task_id="run_backfill",
    python_callable=run_backfill_for_account,
    dag=dag,
)


# =============================================================================
# TASK DEPENDENCIES
# =============================================================================

# Single task - no dependencies needed
_ = t_run_backfill
