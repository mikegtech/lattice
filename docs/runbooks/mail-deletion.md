# Mail Deletion Runbook

Operations guide for email lifecycle deletions in Lattice.

## Overview

The `mail-deleter` worker handles email lifecycle deletions across multiple data stores:
- **Milvus**: Vector embeddings
- **Postgres**: Email records, chunks, and embeddings
- **Object Storage**: Raw email artifacts (planned)

## Deletion Types

### 1. Single Email Deletion
Delete a specific email by ID.

```json
{
  "request_id": "del-123",
  "request_type": "single_email",
  "tenant_id": "tenant-1",
  "account_id": "account-1",
  "email_id": "email-456",
  "deletion_type": "soft",
  "deletion_reason": "user_request",
  "delete_vectors": true,
  "delete_storage": false,
  "delete_postgres": true,
  "requested_at": "2024-01-15T10:30:00Z"
}
```

### 2. Account Deletion
Delete all emails for an account.

```json
{
  "request_id": "del-456",
  "request_type": "account",
  "tenant_id": "tenant-1",
  "account_id": "account-1",
  "deletion_type": "hard",
  "deletion_reason": "gdpr_request",
  "delete_vectors": true,
  "delete_storage": true,
  "delete_postgres": true,
  "requested_at": "2024-01-15T10:30:00Z"
}
```

### 3. Alias Deletion
Delete all emails for a specific alias within an account.

```json
{
  "request_id": "del-789",
  "request_type": "alias",
  "tenant_id": "tenant-1",
  "account_id": "account-1",
  "alias": "work@example.com",
  "deletion_type": "soft",
  "deletion_reason": "user_request",
  "delete_vectors": true,
  "delete_storage": false,
  "delete_postgres": true,
  "requested_at": "2024-01-15T10:30:00Z"
}
```

### 4. Retention Sweep
Delete emails older than a cutoff date (retention policy enforcement).

```json
{
  "request_id": "del-sweep-001",
  "request_type": "retention_sweep",
  "tenant_id": "tenant-1",
  "account_id": "account-1",
  "retention_policy_id": "policy-90d",
  "cutoff_date": "2023-10-15T00:00:00Z",
  "deletion_type": "hard",
  "deletion_reason": "retention_policy",
  "delete_vectors": true,
  "delete_storage": true,
  "delete_postgres": true,
  "requested_at": "2024-01-15T10:30:00Z"
}
```

## Deletion Reasons

| Reason | Description |
|--------|-------------|
| `user_request` | User-initiated deletion |
| `retention_policy` | Automated retention sweep |
| `reprocess` | Cleanup before reprocessing |
| `gdpr_request` | GDPR/privacy compliance |
| `admin_action` | Administrative cleanup |

## Soft vs Hard Delete

- **Soft Delete**: Sets `deleted_at` timestamp on email records. Vector and storage deletion still occurs.
- **Hard Delete**: Permanently removes records from the database.

## Operations

### Trigger a Deletion via Kafka

Produce a message to `lattice.mail.delete.v1`:

```bash
# Using kafkacat/kcat
echo '{"request_id":"del-manual-001","request_type":"single_email","tenant_id":"tenant-1","account_id":"account-1","email_id":"email-123","deletion_type":"soft","deletion_reason":"user_request","delete_vectors":true,"delete_storage":false,"delete_postgres":true,"requested_at":"2024-01-15T10:30:00Z"}' | \
  kcat -P -b $KAFKA_BROKERS -t lattice.mail.delete.v1
```

### Monitor Deletion Progress

Query the `deletion_request` table:

```sql
SELECT
  id,
  request_type,
  status,
  emails_deleted,
  chunks_deleted,
  vectors_deleted,
  started_at,
  completed_at,
  last_error
FROM deletion_request
WHERE tenant_id = 'tenant-1'
ORDER BY requested_at DESC
LIMIT 10;
```

### Check Deletion Status by Request ID

```sql
SELECT * FROM deletion_request WHERE id = 'del-123';
```

### View Failed Deletions

```sql
SELECT
  id,
  request_type,
  last_error,
  requested_at
FROM deletion_request
WHERE status = 'failed'
ORDER BY requested_at DESC;
```

## Idempotency

The mail-deleter is fully idempotent:

1. Each deletion request has a unique `request_id`
2. The `deletion_request` table tracks status
3. Completed requests are skipped on replay
4. Failed requests can be retried automatically

## Partial Failure Handling

The worker handles partial failures gracefully:

- **Milvus errors**: Logged and counted, but Postgres deletion proceeds
- **Postgres errors**: Request marked as failed, can be retried
- **Storage errors**: Not yet implemented (planned)

## Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `deletion.requests.received` | Counter | Deletion requests received |
| `deletion.requests.success` | Counter | Successful deletions |
| `deletion.requests.skipped` | Counter | Skipped (idempotent) |
| `deletion.requests.error` | Counter | Failed deletions |
| `deletion.emails_deleted` | Gauge | Emails deleted per request |
| `deletion.vectors_deleted` | Gauge | Vectors deleted per request |
| `deletion.milvus_ms` | Timing | Milvus deletion latency |

## Troubleshooting

### Deletion Stuck in `in_progress`

If a deletion is stuck, check:
1. Worker logs for errors
2. Milvus connectivity
3. Postgres connectivity

To retry a stuck deletion:
```sql
UPDATE deletion_request
SET status = 'pending', last_error = NULL
WHERE id = 'del-123' AND status = 'in_progress';
```

Then republish the original message to the topic.

### Milvus Deletion Failures

Check Milvus health:
```bash
curl http://milvus:9091/healthz
```

Verify collection exists:
```python
from pymilvus import connections, utility
connections.connect(host="milvus", port="19530")
print(utility.list_collections())
```

### Foreign Key Violations

The worker deletes in FK-safe order:
1. `email_embedding` (references `email_chunk`)
2. `email_chunk` (references `email`)
3. `email` (base table)

If you see FK violations, check for orphaned records.

## Kafka Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `lattice.mail.delete.v1` | Input | Deletion requests |
| `lattice.mail.delete.completed.v1` | Output | Completion events |
| `lattice.dlq.mail.delete.v1` | DLQ | Non-retryable failures |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MILVUS_HOST` | `localhost` | Milvus hostname |
| `MILVUS_PORT` | `19530` | Milvus port |
| `MILVUS_COLLECTION` | `email_chunks_v1` | Collection name |
| `DATABASE_URL` | - | Postgres connection string |
| `KAFKA_TOPIC_IN` | `lattice.mail.delete.v1` | Input topic |
| `KAFKA_TOPIC_OUT` | `lattice.mail.delete.completed.v1` | Output topic |
