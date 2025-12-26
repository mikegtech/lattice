# Retention Sweep Runbook

Operations guide for the `lattice__retention_sweep` Airflow DAG.

## Overview

The retention sweep DAG identifies emails eligible for deletion based on a cutoff date and publishes deletion requests to Kafka. The actual deletion is performed by the `mail-deleter` worker.

**Key Principle**: Airflow orchestrates only - it does NOT delete data directly.

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  Retention Sweep    │────▶│  lattice.mail.       │────▶│  mail-deleter   │
│  DAG (Airflow)      │     │  delete.v1 (Kafka)   │     │  worker         │
└─────────────────────┘     └──────────────────────┘     └─────────────────┘
         │                                                        │
         │                                                        ▼
         ▼                                               ┌─────────────────┐
┌─────────────────────┐                                  │  Postgres       │
│  retention_sweep_   │                                  │  Milvus         │
│  run (Postgres)     │                                  │  Object Storage │
└─────────────────────┘                                  └─────────────────┘
```

## DAG Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tenant_id` | string | `"personal"` | Tenant to sweep |
| `account_id` | string | null | Optional: specific account |
| `alias` | string | null | Optional: specific alias |
| `cutoff_date` | string | 365 days ago | YYYY-MM-DD or ISO8601 |
| `max_emails_per_run` | integer | 500 | Max emails per run (1-5000) |
| `force` | boolean | false | Force rerun if completed |

## Triggering Sweeps

### Daily Automatic Sweep

The DAG runs daily at midnight with default parameters:
- Tenant: `personal`
- Cutoff: 365 days ago
- Max emails: 500

### Manual Sweep via CLI

```bash
# Default sweep (365 days ago)
airflow dags trigger lattice__retention_sweep

# Custom cutoff date
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2023-06-01"}'

# Specific account
airflow dags trigger lattice__retention_sweep \
    --conf '{"tenant_id": "personal", "account_id": "personal-gmail"}'

# Specific alias
airflow dags trigger lattice__retention_sweep \
    --conf '{"tenant_id": "personal", "alias": "work@example.com"}'

# Large batch
airflow dags trigger lattice__retention_sweep \
    --conf '{"max_emails_per_run": 2000}'

# Force rerun of completed sweep
airflow dags trigger lattice__retention_sweep \
    --conf '{"tenant_id": "personal", "cutoff_date": "2023-01-01", "force": true}'
```

### Manual Sweep via Airflow UI

1. Navigate to DAGs → `lattice__retention_sweep`
2. Click "Trigger DAG w/ config"
3. Fill in parameters as JSON
4. Click "Trigger"

## Monitoring Progress

### Sweep Run Table

Query `retention_sweep_run` to monitor sweep progress:

```sql
-- Recent sweeps
SELECT
    id,
    tenant_id,
    cutoff_date::date,
    status,
    emails_targeted,
    emails_published,
    created_at,
    completed_at
FROM retention_sweep_run
ORDER BY created_at DESC
LIMIT 10;

-- Running sweeps
SELECT * FROM retention_sweep_run WHERE status = 'running';

-- Failed sweeps
SELECT id, tenant_id, cutoff_date, last_error
FROM retention_sweep_run
WHERE status = 'failed'
ORDER BY created_at DESC;
```

### Deletion Ledger

Query `deletion_request` to verify deletions are being processed:

```sql
-- Recent deletion requests from retention sweep
SELECT
    id,
    tenant_id,
    account_id,
    request_type,
    status,
    emails_deleted,
    vectors_deleted,
    created_at,
    completed_at
FROM deletion_request
WHERE request_json->>'deletion_reason' = 'retention_policy'
ORDER BY created_at DESC
LIMIT 20;

-- Pending deletions
SELECT COUNT(*), status
FROM deletion_request
WHERE request_json->>'deletion_reason' = 'retention_policy'
GROUP BY status;
```

### Audit Events

Query `audit_event` to see deletion audit trail:

```sql
SELECT
    event_type,
    entity_id,
    outcome,
    timestamp
FROM audit_event
WHERE event_type LIKE 'email.delete%'
ORDER BY timestamp DESC
LIMIT 20;
```

## Idempotency & Resumability

### How It Works

1. **Sweep Creation**: Each sweep creates a record in `retention_sweep_run`
2. **Uniqueness**: Only one running sweep per (tenant_id, cutoff_date)
3. **Checkpointing**: Progress saved every 100 emails via `last_email_id`
4. **Resumption**: If DAG restarts, it continues from checkpoint

### Rerunning a Completed Sweep

By default, completed sweeps are skipped:

```bash
# This will skip if already completed
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2023-06-01"}'

# Use force=true to rerun
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2023-06-01", "force": true}'
```

### Resuming a Failed Sweep

Failed sweeps can be resumed by triggering with the same parameters:

```bash
# Just trigger again - it will resume from checkpoint
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2023-06-01"}'
```

To start fresh instead:

```sql
-- Mark old run as failed (allows new run)
UPDATE retention_sweep_run
SET status = 'failed'
WHERE tenant_id = 'personal'
  AND cutoff_date = '2023-06-01'
  AND status = 'running';
```

## Troubleshooting

### Sweep Stuck in "Running"

If a sweep is stuck:

1. Check Airflow task logs for errors
2. Check `last_email_id` checkpoint in sweep table
3. Either resume (trigger again) or reset:

```sql
UPDATE retention_sweep_run
SET status = 'failed', last_error = 'Manual reset'
WHERE id = '<sweep_id>' AND status = 'running';
```

### No Emails Being Selected

Verify emails exist matching criteria:

```sql
SELECT COUNT(*)
FROM email
WHERE tenant_id = 'personal'
  AND received_at < '2023-06-01'
  AND deletion_status = 'active'
  AND deleted_at IS NULL;
```

### Kafka Publishing Failures

1. Check Airflow logs for Kafka errors
2. Verify Kafka credentials in environment
3. Check topic ACLs for `lattice.mail.delete.v1`
4. Resume sweep (it will continue from checkpoint)

### Deletions Not Completing

If deletion requests are published but not processed:

1. Check `mail-deleter` worker is running:
   ```bash
   docker logs lattice-mail-deleter --tail 50
   ```

2. Check deletion_request table for pending/failed:
   ```sql
   SELECT status, COUNT(*)
   FROM deletion_request
   GROUP BY status;
   ```

3. Check for Kafka consumer lag

## Metrics

### Sweep Metrics (Airflow)

- Task duration in Airflow UI
- `emails_targeted` and `emails_published` in sweep table

### Deletion Metrics (mail-deleter)

| Metric | Description |
|--------|-------------|
| `deletion.requests.received` | Requests received |
| `deletion.requests.success` | Successful deletions |
| `deletion.emails_deleted` | Emails deleted |
| `deletion.vectors_deleted` | Vectors deleted |

## Safety Considerations

### Dry Run

There's no built-in dry run, but you can simulate:

```sql
-- Count what WOULD be deleted
SELECT COUNT(*)
FROM email
WHERE tenant_id = 'personal'
  AND received_at < '2023-06-01'
  AND deletion_status = 'active'
  AND deleted_at IS NULL;
```

### Limiting Blast Radius

- Start with small `max_emails_per_run` (100-500)
- Use `account_id` filter for targeted sweeps
- Monitor first sweep before running large batches

### Rollback

Deletions are **not reversible** once processed. For safety:
- Use soft deletes first (`deletion_type: "soft"`)
- Keep backups of raw email data in object storage
- Verify sweep targets before running large batches

## Example Workflows

### Quarterly Retention Enforcement

```bash
# Delete emails older than 1 year, 2000 at a time
airflow dags trigger lattice__retention_sweep \
    --conf '{
        "cutoff_date": "2023-12-01",
        "max_emails_per_run": 2000
    }'
```

### Account Cleanup Before Removal

```bash
# Delete all emails for specific account
airflow dags trigger lattice__retention_sweep \
    --conf '{
        "account_id": "old-account",
        "cutoff_date": "2099-01-01"
    }'
```

### Alias-Specific Cleanup

```bash
# Delete old emails for specific alias
airflow dags trigger lattice__retention_sweep \
    --conf '{
        "alias": "newsletters@example.com",
        "cutoff_date": "2024-01-01",
        "max_emails_per_run": 1000
    }'
```
