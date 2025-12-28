# Lattice Worker Reference

Quick reference for all NestJS Kafka workers. Use this to rehydrate context when debugging errors.

---

## How to Use This Document

When you see an error in Datadog:
1. Find the `service` field (e.g., `lattice-worker-mail-deleter`)
2. Look up the worker below
3. Use the context for debugging

---

## Worker Index

| Service | Domain | Stage | Input Topic | Output Topic |
|---------|--------|-------|-------------|--------------|
| `lattice-worker-mail-parser` | mail | parse | `lattice.mail.raw.v1` | `lattice.mail.parse.v1` |
| `lattice-worker-mail-chunker` | mail | chunk | `lattice.mail.parse.v1` | `lattice.mail.chunk.v1` |
| `lattice-worker-mail-embedder` | mail | embed | `lattice.mail.chunk.v1` | `lattice.mail.embed.v1` |
| `lattice-worker-mail-upserter` | mail | upsert | `lattice.mail.embed.v1` | `lattice.mail.upsert.v1` |
| `lattice-worker-mail-deleter` | mail | delete | `lattice.mail.delete.v1` | `lattice.mail.delete.completed.v1` |
| `lattice-worker-audit-writer` | audit | audit | `lattice.audit.events.v1` | *(terminal)* |

---

## mail-parser

**Service**: `lattice-worker-mail-parser`
**Location**: `apps/workers/mail-parser/`

### Topics
- **Input**: `lattice.mail.raw.v1`
- **Output**: `lattice.mail.parse.v1`
- **DLQ**: `lattice.dlq.mail.parse.v1`

### Responsibilities
1. Consume raw RFC822 email from object storage
2. Parse headers, body, attachments
3. Extract metadata (from, to, subject, date)
4. Publish structured email to output topic

### Producers (who sends to this worker)
- Airflow DAGs: `lattice__gmail_sync_incremental`, `lattice__imap_sync_incremental`
- Backfill DAGs: `lattice__gmail_backfill`, `lattice__imap_backfill`

### Common Errors
| Error Code | Cause | Fix |
|------------|-------|-----|
| `PARSE_ERROR` | Malformed RFC822 | Check raw email in object storage |
| `STORAGE_ERROR` | Can't fetch from MinIO/S3 | Check storage connectivity |
| `ENVELOPE_INVALID` | Missing envelope fields | Check producer is wrapping correctly |

### Related Docs
- Schema: `contracts/kafka/mail/raw/v1.json`
- Runbook: `docs/runbooks/local-development.md`

---

## mail-chunker

**Service**: `lattice-worker-mail-chunker`
**Location**: `apps/workers/mail-chunker/`

### Topics
- **Input**: `lattice.mail.parse.v1`
- **Output**: `lattice.mail.chunk.v1`
- **DLQ**: `lattice.dlq.mail.chunk.v1`

### Responsibilities
1. Consume parsed email events
2. Split email body into semantic chunks
3. Generate deterministic chunk hashes
4. Persist chunks to Postgres
5. Publish chunk references to output topic

### Producers
- `lattice-worker-mail-parser`

### Common Errors
| Error Code | Cause | Fix |
|------------|-------|-----|
| `PARSE_ERROR` | Invalid input payload | Check mail-parser output |
| `DB_ERROR` | Postgres connection/query failure | Check DB connectivity |
| `DUPLICATE_SKIP` | Chunk already exists (idempotent) | Not an error, expected |

### Related Docs
- Schema: `contracts/kafka/mail/chunk/v1.json`

---

## mail-embedder

**Service**: `lattice-worker-mail-embedder`
**Location**: `apps/workers/mail-embedder/`

### Topics
- **Input**: `lattice.mail.chunk.v1`
- **Output**: `lattice.mail.embed.v1`
- **DLQ**: `lattice.dlq.mail.embed.v1`

### Responsibilities
1. Consume chunk events
2. Check idempotency (chunk_hash + embedding_version)
3. Generate embeddings via provider abstraction
4. Persist embedding metadata to Postgres
5. Publish embedding references to output topic

### Producers
- `lattice-worker-mail-chunker`

### Common Errors
| Error Code | Cause | Fix |
|------------|-------|-----|
| `EMBEDDING_FAILED` | Provider error (OpenAI, local) | Check provider connectivity/quota |
| `RATE_LIMITED` | Too many requests | Will auto-retry with backoff |
| `DUPLICATE_SKIP` | Already embedded | Not an error, expected |

### Related Docs
- Schema: `contracts/kafka/mail/embed/v1.json`

---

## mail-upserter

**Service**: `lattice-worker-mail-upserter`
**Location**: `apps/workers/mail-upserter/`

### Topics
- **Input**: `lattice.mail.embed.v1`
- **Output**: `lattice.mail.upsert.v1`
- **DLQ**: `lattice.dlq.mail.upsert.v1`

### Responsibilities
1. Consume embedding events
2. Fetch embedding vectors from Postgres
3. Upsert vectors to Milvus
4. Publish upsert confirmation to output topic

### Producers
- `lattice-worker-mail-embedder`

### Common Errors
| Error Code | Cause | Fix |
|------------|-------|-----|
| `MILVUS_ERROR` | Milvus connection/query failure | Check Milvus health |
| `VECTOR_DIM_MISMATCH` | Wrong embedding dimensions | Check embedding model config |
| `COLLECTION_NOT_FOUND` | Milvus collection missing | Run collection init |

### Related Docs
- Schema: `contracts/kafka/mail/upsert/v1.json`
- Runbook: `docs/runbooks/local-development.md`

---

## mail-deleter

**Service**: `lattice-worker-mail-deleter`
**Location**: `apps/workers/mail-deleter/`

### Topics
- **Input**: `lattice.mail.delete.v1`
- **Output**: `lattice.mail.delete.completed.v1`
- **DLQ**: `lattice.dlq.mail.delete.v1`

### Responsibilities
1. Consume deletion request events
2. Validate request payload
3. Resolve affected emails (single, account, alias, retention)
4. Delete from Milvus (vectors)
5. Delete from Postgres (soft or hard)
6. Track progress in `deletion_request` table
7. Publish audit events to `lattice.audit.events.v1`

### Producers
- Airflow DAG: `lattice__retention_sweep`
- Manual API calls (future)

### Common Errors
| Error Code | Cause | Fix |
|------------|-------|-----|
| `PARSE_ERROR` | **Envelope validation failed** | Producer not wrapping in Lattice envelope |
| `MILVUS_ERROR` | Can't delete from Milvus | Check Milvus connectivity |
| `DB_ERROR` | Postgres failure | Check DB connectivity |
| `INVALID_REQUEST` | Missing required fields | Check producer payload |

### Related Docs
- Schema: `contracts/kafka/mail/delete/v1.json`
- Runbook: `docs/runbooks/mail-deletion.md`
- Runbook: `docs/runbooks/retention-sweep.md`

---

## audit-writer

**Service**: `lattice-worker-audit-writer`
**Location**: `apps/workers/audit-writer/`

### Topics
- **Input**: `lattice.audit.events.v1`
- **Output**: *(none - terminal consumer)*
- **DLQ**: `lattice.dlq.audit.events.v1`

### Responsibilities
1. Consume audit events from all services
2. Validate audit event schema
3. Persist to `audit_event` table in Postgres
4. Ensure idempotency via deterministic event ID

### Producers
- `lattice-worker-mail-deleter`
- `lattice-worker-mail-parser` (future)
- All workers emit audit events

### Common Errors
| Error Code | Cause | Fix |
|------------|-------|-----|
| `PARSE_ERROR` | Invalid audit event | Check producer payload |
| `DB_ERROR` | Postgres failure | Check DB connectivity |
| `DUPLICATE_SKIP` | Event already persisted | Not an error, expected |

### Related Docs
- Schema: `contracts/kafka/audit/events/v1.json`

---

## Error Code Reference

Global error codes used across all workers:

| Code | Category | Description | Retryable? |
|------|----------|-------------|------------|
| `PARSE_ERROR` | Validation | Message parsing/validation failed | No → DLQ |
| `ENVELOPE_INVALID` | Validation | Lattice envelope missing/malformed | No → DLQ |
| `SCHEMA_MISMATCH` | Validation | Schema version incompatible | No → DLQ |
| `DB_ERROR` | Infrastructure | Database operation failed | Yes |
| `MILVUS_ERROR` | Infrastructure | Vector DB operation failed | Yes |
| `STORAGE_ERROR` | Infrastructure | Object storage operation failed | Yes |
| `KAFKA_ERROR` | Infrastructure | Kafka produce/consume failed | Yes |
| `RATE_LIMITED` | External | External API rate limit | Yes (with backoff) |
| `TIMEOUT` | Infrastructure | Operation timed out | Yes |
| `DUPLICATE_SKIP` | Idempotency | Already processed, skipping | N/A (success) |

---

## Message Flow Diagram

```
                              ┌─────────────────────┐
                              │  Airflow DAGs       │
                              │  (Gmail/IMAP Sync)  │
                              └──────────┬──────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         lattice.mail.raw.v1                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │    mail-parser      │
                              └──────────┬──────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        lattice.mail.parse.v1                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │   mail-chunker      │
                              └──────────┬──────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        lattice.mail.chunk.v1                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │   mail-embedder     │
                              └──────────┬──────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        lattice.mail.embed.v1                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │   mail-upserter     │
                              └──────────┬──────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        lattice.mail.upsert.v1                               │
└─────────────────────────────────────────────────────────────────────────────┘


DELETION FLOW (separate):

┌─────────────────────────────────────────────────────────────────────────────┐
│  Airflow: lattice__retention_sweep                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       lattice.mail.delete.v1                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │   mail-deleter      │──────▶ lattice.audit.events.v1
                              └──────────┬──────────┘                │
                                         │                           ▼
                                         ▼                  ┌─────────────────┐
                              Postgres + Milvus             │  audit-writer   │
                                                            └─────────────────┘
```

---

## Rehydration Template

When debugging an error, use this template:

```
## Error Context

**From Datadog:**
- Service: <service from log>
- Error Code: <error_code>
- Error Message: <error_message>
- DLQ Topic: <dlq_topic>
- Timestamp: <timestamp>

## Worker Reference

**Worker**: <look up from index above>
**Location**: apps/workers/<worker>/
**Input Topic**: <from reference>
**Output Topic**: <from reference>

## Producers

Who sends messages to this worker:
- <list from reference>

## Investigation Steps

1. Check producer is wrapping in Lattice envelope
2. Check schema version matches
3. Check required fields in payload
4. Check infrastructure connectivity (DB, Milvus, Kafka)

## Related Docs
- Schema: contracts/kafka/<path>
- Runbook: docs/runbooks/<path>
```
