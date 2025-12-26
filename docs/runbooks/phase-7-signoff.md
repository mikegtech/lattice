# Phase 7 Sign-off: Retention Sweep

Verification checklist for the retention sweep DAG implementation.

## Preconditions

Before testing, ensure:

1. **PostgreSQL migration applied**:
   ```bash
   # Verify retention_sweep_run table exists
   docker exec -it lattice-postgres psql -U lattice -d lattice -c "\d retention_sweep_run"
   ```

2. **Kafka topic exists with ACLs**:
   ```bash
   # Topic: lattice.mail.delete.v1
   # Required ACLs: READ, WRITE for airflow client
   ```

3. **mail-deleter worker running**:
   ```bash
   curl http://localhost:3006/health
   # Expected: {"status":"ok"}
   ```

4. **Airflow running with DAG loaded**:
   ```bash
   docker exec -it lattice-airflow airflow dags list | grep retention_sweep
   # Expected: lattice__retention_sweep
   ```

5. **Test data available**:
   ```sql
   -- Verify emails exist for testing
   SELECT COUNT(*) FROM email
   WHERE tenant_id = 'personal'
     AND deletion_status = 'active'
     AND deleted_at IS NULL;
   ```

## Manual Trigger Examples

### Basic Sweep (365 days cutoff)

```bash
airflow dags trigger lattice__retention_sweep
```

### Custom Cutoff Date

```bash
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2024-06-01"}'
```

### Specific Account

```bash
airflow dags trigger lattice__retention_sweep \
    --conf '{"tenant_id": "personal", "account_id": "personal-gmail"}'
```

### Small Batch for Testing

```bash
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2024-01-01", "max_emails_per_run": 10}'
```

### Force Rerun of Completed Sweep

```bash
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2024-01-01", "force": true}'
```

## Verify Resumability

Test that sweeps can resume from checkpoint after interruption.

### Step 1: Start a Large Sweep

```bash
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2024-12-01", "max_emails_per_run": 100}'
```

### Step 2: Check Checkpoint Progress

```sql
SELECT
    id,
    status,
    emails_targeted,
    emails_published,
    last_received_at,
    last_email_id
FROM retention_sweep_run
WHERE status = 'running'
ORDER BY created_at DESC
LIMIT 1;
```

### Step 3: Simulate Failure (Optional)

```sql
-- Mark sweep as failed to test resume
UPDATE retention_sweep_run
SET status = 'failed', last_error = 'Test interruption'
WHERE status = 'running'
  AND tenant_id = 'personal';
```

### Step 4: Trigger Resume

```bash
# Re-trigger with same parameters - should resume from checkpoint
airflow dags trigger lattice__retention_sweep \
    --conf '{"cutoff_date": "2024-12-01", "max_emails_per_run": 100}'
```

### Step 5: Verify Resume Behavior

```sql
-- Should see multiple runs, latest continuing from previous checkpoint
SELECT
    id,
    status,
    emails_published,
    last_email_id,
    created_at
FROM retention_sweep_run
WHERE tenant_id = 'personal'
  AND cutoff_date::date = '2024-12-01'
ORDER BY created_at DESC;
```

## Verify Completion

A sweep is complete when it processes fewer emails than `max_emails_per_run`.

### Check Completion Status

```sql
SELECT
    id,
    tenant_id,
    cutoff_date::date,
    status,
    emails_targeted,
    emails_published,
    completed_at
FROM retention_sweep_run
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 5;
```

### Verify Completion Logic

- `status = 'completed'` only when `emails_targeted < max_emails_per_run`
- `status = 'running'` when more emails remain to process
- `completed_at` timestamp set when status becomes 'completed'

## Verify Deletion Commands Queued

### Check Deletion Requests in Ledger

```sql
SELECT
    id,
    tenant_id,
    account_id,
    request_type,
    status,
    created_at
FROM deletion_request
WHERE request_json->>'deletion_reason' = 'retention_policy'
ORDER BY created_at DESC
LIMIT 20;
```

### Count Pending Deletions

```sql
SELECT status, COUNT(*)
FROM deletion_request
WHERE request_json->>'deletion_reason' = 'retention_policy'
GROUP BY status;
```

### Verify Kafka Message Format

Check mail-deleter worker logs for received messages:

```bash
docker logs lattice-mail-deleter --tail 100 | grep "Processing deletion"
```

Expected message format:
```json
{
  "request_type": "single",
  "tenant_id": "personal",
  "email_id": "<uuid>",
  "deletion_type": "soft",
  "deletion_reason": "retention_policy"
}
```

## Verify Execution Completeness

### End-to-End Verification

1. **Count eligible emails before sweep**:
   ```sql
   SELECT COUNT(*) as eligible_count
   FROM email
   WHERE tenant_id = 'personal'
     AND received_at < '2024-01-01'
     AND deletion_status = 'active'
     AND deleted_at IS NULL;
   ```

2. **Run sweep to completion**:
   ```bash
   # Run with force until status = 'completed'
   airflow dags trigger lattice__retention_sweep \
       --conf '{"cutoff_date": "2024-01-01", "max_emails_per_run": 1000}'
   ```

3. **Verify sweep published all emails**:
   ```sql
   SELECT
       SUM(emails_published) as total_published
   FROM retention_sweep_run
   WHERE tenant_id = 'personal'
     AND cutoff_date::date = '2024-01-01';
   ```

4. **Verify deletion requests processed**:
   ```sql
   SELECT
       status,
       COUNT(*) as count,
       SUM(emails_deleted) as emails_deleted
   FROM deletion_request
   WHERE request_json->>'deletion_reason' = 'retention_policy'
   GROUP BY status;
   ```

5. **Verify emails marked deleted**:
   ```sql
   SELECT COUNT(*) as deleted_count
   FROM email
   WHERE tenant_id = 'personal'
     AND received_at < '2024-01-01'
     AND deletion_status = 'deleted';
   ```

### Audit Trail Verification

```sql
SELECT
    event_type,
    entity_type,
    outcome,
    COUNT(*) as count
FROM audit_event
WHERE event_type LIKE 'email.delete%'
  AND timestamp > NOW() - INTERVAL '1 hour'
GROUP BY event_type, entity_type, outcome;
```

## Operational Guidance

### Monitoring Active Sweeps

```sql
-- Dashboard query for active sweeps
SELECT
    id,
    tenant_id,
    cutoff_date::date,
    emails_published,
    EXTRACT(EPOCH FROM (NOW() - created_at))/60 as minutes_running
FROM retention_sweep_run
WHERE status = 'running';
```

### Handling Stuck Sweeps

If a sweep appears stuck (no progress for >10 minutes):

1. Check Airflow task logs for errors
2. Check Kafka connectivity
3. Reset if necessary:
   ```sql
   UPDATE retention_sweep_run
   SET status = 'failed', last_error = 'Manual reset - stuck'
   WHERE id = '<sweep_id>' AND status = 'running';
   ```

### Safe Batch Sizes

| Environment | Recommended max_emails_per_run |
|-------------|-------------------------------|
| Development | 10-50 |
| Testing     | 100-500 |
| Production  | 500-2000 |

### Backpressure Handling

If mail-deleter falls behind:
1. Reduce `max_emails_per_run` for new sweeps
2. Monitor Kafka consumer lag
3. Scale mail-deleter workers if needed

## Non-Goals

This phase does **NOT** include:

- **Hard deletes**: Only soft deletes are implemented. Hard delete requires separate approval workflow.
- **Cross-tenant sweeps**: Each sweep targets a single tenant.
- **Real-time streaming**: Batch-based approach only.
- **Automatic scheduling configuration**: Schedule changes require DAG code update.
- **Undo/rollback**: Deletions are not reversible through this system.
- **Compliance reporting**: Audit events are logged but no compliance reports generated.
- **Object storage cleanup**: Only Postgres and Milvus are cleaned; object storage cleanup is future work.

## Sign-off Checklist

- [ ] Migration 007 applied successfully
- [ ] DAG loads without import errors
- [ ] Manual trigger works with default parameters
- [ ] Manual trigger works with custom cutoff_date
- [ ] Sweep creates record in retention_sweep_run
- [ ] Sweep publishes to Kafka (check mail-deleter logs)
- [ ] Deletion requests appear in deletion_request table
- [ ] Resumability works (checkpoint saved and restored)
- [ ] Completion logic correct (status='completed' only when batch < max)
- [ ] Audit events logged for deletions
- [ ] Pre-commit checks pass
