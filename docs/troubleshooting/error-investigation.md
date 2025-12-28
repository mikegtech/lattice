# Error Investigation Template

Use this template when creating a Claude Code prompt from a Datadog error.

---

## Template

```markdown
## Context

You are working in the "lattice" monorepo on main.

**Rehydrate context:**
- Read `docs/ai/context.md`
- Read `docs/workers/README.md` (worker reference)
- Read `docs/runbooks/<relevant-runbook>.md`
- Read `.github/instructions/*.md`

---

## Error from Datadog

```json
<paste full JSON log here>
```

---

## Worker Context

**Worker**: <service name from error>
**Location**: `apps/workers/<worker>/`
**Domain**: <domain from error>
**Stage**: <stage from error>

### Topics
- **Input**: <from worker reference>
- **Output**: <from worker reference>
- **DLQ**: <dlq_topic from error>

### Producers (who sends to this worker)
- <from worker reference>

---

## Objective

Investigate and fix the error: `<error_code>: <brief error_message>`

---

## Investigation Steps

1. Identify the producer sending malformed messages
2. Check if producer wraps payload in Lattice envelope
3. Verify schema version matches expected
4. Check required fields per contract schema

---

## Constraints

- Do NOT modify the consumer's envelope validation (it's correct)
- Fix at the producer side
- Keep CI green
- Update tests if behavior changes

---

## After Fix

- Summarize root cause
- Describe the fix
- Provide test steps to verify
```

---

## Example: mail-deleter PARSE_ERROR

```markdown
## Context

You are working in the "lattice" monorepo on main.

**Rehydrate context:**
- Read `docs/ai/context.md`
- Read `docs/workers/README.md`
- Read `docs/runbooks/mail-deletion.md`
- Read `docs/runbooks/retention-sweep.md`

---

## Error from Datadog

```json
{
  "service": "lattice-worker-mail-deleter",
  "domain": "mail",
  "stage": "delete",
  "error_code": "PARSE_ERROR",
  "error_message": "Envelope validation failed: Missing required field: message_id; Missing required field: domain; Missing required field: stage; Missing required field: schema_version; Missing required field: created_at; Missing required field: source; Missing required field: data_classification; Missing required field: pii; Missing required field: payload; Schema version mismatch: expected v1, got undefined",
  "dlq_topic": "lattice.dlq.mail.delete.v1",
  "event": "lattice.message.dlq",
  "timestamp": "2025-12-28T11:32:46.456Z"
}
```

---

## Worker Context

**Worker**: lattice-worker-mail-deleter
**Location**: `apps/workers/mail-deleter/`
**Domain**: mail
**Stage**: delete

### Topics
- **Input**: `lattice.mail.delete.v1`
- **Output**: `lattice.mail.delete.completed.v1`
- **DLQ**: `lattice.dlq.mail.delete.v1`

### Producers (who sends to this worker)
- Airflow DAG: `lattice__retention_sweep` (`python/dags/lattice_retention_sweep.py`)
- Python Kafka producer: `python/packages/lattice_kafka/src/lattice_kafka/producer.py`

---

## Objective

Fix: Producer is not wrapping payloads in Lattice envelope format.

The Python KafkaProducer publishes raw payloads, but NestJS workers expect messages wrapped in the standard Lattice envelope with required fields.

---

## Investigation Steps

1. Examine `python/packages/lattice_kafka/src/lattice_kafka/producer.py`
2. Compare to `contracts/kafka/envelope.json` (required fields)
3. Compare to `packages/core-contracts/src/kafka/envelope.ts` (NestJS definition)
4. Update Python producer to wrap payloads in envelope format

---

## Required Envelope Fields

```json
{
  "message_id": "uuid",
  "schema_version": "v1",
  "domain": "mail",
  "stage": "delete",
  "created_at": "ISO8601 timestamp",
  "source": {
    "service": "airflow-retention-sweep",
    "version": "1.0.0"
  },
  "data_classification": "internal",
  "pii": true,
  "payload": { /* actual deletion request */ }
}
```

---

## Constraints

- Do NOT modify NestJS envelope validation
- Fix in Python producer
- Maintain backward compatibility
- Keep CI green

---

## After Fix

- Python KafkaProducer wraps all payloads in envelope
- Retention sweep messages process successfully
- No DLQ entries for envelope validation errors
- Test: trigger retention sweep, verify messages processed
```

---

## Checklist: Does the Error Have Enough Info?

When a DLQ event fires, check if these fields are present:

### Required (Currently Have)
- [x] `service` - Which worker
- [x] `error_code` - Error classification
- [x] `error_message` - Detailed description
- [x] `dlq_topic` - Where message went
- [x] `domain` / `stage` - Worker context
- [x] `timestamp` - When it happened
- [x] `env` - Environment

### Should Add (Currently Missing)
- [ ] `input_topic` - Where message came from
- [ ] `kafka_partition` - For message lookup
- [ ] `kafka_offset` - For message lookup
- [ ] `producer_service` - Who sent the message (if known from headers)

---

## Checklist: Do Docs Provide Enough Context?

### Currently Have
- [x] `docs/ai/context.md` - Phase status, completed work
- [x] `docs/runbooks/mail-deletion.md` - Deletion operations
- [x] `docs/runbooks/retention-sweep.md` - Sweep operations
- [x] `.github/instructions/*.md` - Coding guidelines

### Should Add
- [ ] `docs/workers/README.md` - Worker quick reference (created above)
- [ ] `docs/troubleshooting/error-codes.md` - Error code glossary
- [ ] `docs/architecture/message-flow.md` - Producer → Consumer mapping
- [ ] Contract schemas easily discoverable from worker docs
