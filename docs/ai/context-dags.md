# Lattice Airflow DAGs — Rehydration Context

This document is the **single source of truth** for debugging and operating Lattice's Airflow DAG pipelines under `python/dags/`.

If you are diagnosing ingestion or retention pipeline issues, start here before reading worker code.

---

## What This Area Does (High-Level)

Airflow is used for **orchestration only**:
- For mail ingestion, Airflow coordinates provider fetch + object storage write + Kafka publish (raw topic).
- For retention, Airflow **identifies eligible emails** and publishes **deletion requests** to Kafka for the TypeScript `mail-deleter` worker to execute (Airflow does not delete data directly).

---

## Current DAG Inventory (Source of Truth)

### Incremental Sync (scheduled)
- `lattice__gmail_sync_incremental` (every 10 min)
- `lattice__imap_sync_incremental` (every 10 min)

### Backfill (catchup-based, daily)
- `lattice__gmail_backfill` (`@daily`, catchup=True)
- `lattice__imap_backfill` (`@daily`, catchup=True)

### Lifecycle / Retention (scheduled)
- `lattice__retention_sweep` (`@daily`)

### Shared logic module (do not duplicate logic in each DAG)
- `python/dags/lattice_mail_tasks.py` — shared task functions used by multiple DAGs

---

## Key Pipeline Contracts (Invariants)

These rules are relied upon by downstream workers and are intentionally conservative:

1) Airflow is orchestration-only for retention
   - Retention DAG only **selects** and **publishes** deletion requests; it does not delete directly.

2) Incremental sync watermarking only advances on "full success"
   - Gmail: watermark update occurs only after processing, and only if the run wasn't fully failing (guarded by fetched vs errors).
   - IMAP: watermark advances to `last_success_uid`, which is only updated after store + publish + move-to-alias-folder succeed.

3) Object storage is the durable raw source
   - Both Gmail/IMAP flows store RFC822 bytes in object storage before Kafka publish.

4) Kafka publish is optional in local/partial envs
   - Producer is instantiated only if bootstrap servers exist; otherwise it will be `None`. This is intentional for local development.

5) Avoid PII in Airflow logs
   - Retention sweep logs parameter summaries without PII and retains only identifiers + counts.
   - Eligible email selection returns a minimal non-PII shape (no subject, addresses, etc.).

6) Backfill DAGs do not update incremental watermarks
   - Backfill operates on a separate path; incremental sync watermarks are never modified by backfill runs.

---

## Canonical Message Flow (DAG → Kafka → Workers)

### Incremental Gmail/IMAP Sync
Airflow task logic (via `lattice_mail_tasks.py`) does:
1. Load watermark
2. Fetch new messages
3. Store raw RFC822 to object storage
4. Build raw-event payload (includes attachment manifest)
5. Publish to `lattice.mail.raw.v1`
6. Post-process provider-side (label/move)
7. Update watermark (only on full success)

Gmail-specific: uses History API when watermark exists; falls back to query when history is stale/fails.

IMAP-specific: uses UID + UIDVALIDITY, and resets watermark if UIDVALIDITY changes.

### Backfill (Catchup-Based)
Backfill DAGs use Airflow's catchup mechanism to process historical data day-by-day:
1. DAG `start_date` and `end_date` define the backfill window
2. Airflow creates one run per day via `catchup=True`
3. `depends_on_past=True` ensures sequential processing (Day N waits for Day N-1)
4. Each run loops internally until ALL messages for that day are processed (batch size: 100)
5. Idempotency via provider-side markers (Gmail labels / IMAP folder move)

Gmail backfill is idempotent by:
- Query excludes already-labeled messages: `after:YYYY/MM/DD before:YYYY/MM/DD -label:Lattice/{alias}`
- After processing, applies `Lattice/{alias}` label

IMAP backfill is idempotent by:
- Only searches source folder (e.g., INBOX)
- After processing, moves message to `Lattice/{alias}` folder

### Retention Sweep
Retention sweep (`lattice__retention_sweep`) does:
1. Validate params (defaults cutoff to ~365 days ago; bounds max_emails)
2. Load or create a resumable sweep run
3. Select eligible emails using stable tuple cursor `(received_at, id)`
4. Publish deletion requests to Kafka (with envelope wrapper)
5. Update sweep run status and checkpoint cursor as it publishes

Design properties are explicit in the DAG module docstring: tuple cursor, idempotent, resumable.

---

## DAG-by-DAG Operational Details

### lattice__gmail_sync_incremental
- Schedule: every 10 minutes
- Loads enabled Gmail accounts and processes each via dynamic task mapping.
- Watermark: Gmail `historyId` from profile; fallback to query if history fails.
- Post-processing: applies label `Lattice/<alias>` to mark processed.

### lattice__imap_sync_incremental
- Schedule: every 10 minutes; fetches new messages since watermark.
- Watermark: `(uidvalidity, last_uid)`; resets if UIDVALIDITY changes.
- Post-processing: moves message to alias folder.
- Watermark advances only to `last_success_uid` (ensures move completed).

### lattice__gmail_backfill (catchup-based)
- Schedule: `@daily` with `catchup=True`
- Configuration via Airflow Variables:
  - `lattice_gmail_tenant_id` (default: `personal`)
  - `lattice_gmail_account_id` (default: `personal-gmail`)
  - `lattice_gmail_alias` (default: `inbox`)
- Backfill window: set `BACKFILL_START_DATE` and `BACKFILL_END_DATE` in DAG file
- Processing: loops internally with batch size 100 until day is exhausted
- Idempotency: query excludes `-label:Lattice/{alias}`, then applies label after processing
- Sequential: `depends_on_past=True` ensures days process in order
- Does not update incremental sync watermark

**Usage:**
```bash
# Set variables (optional if defaults match your setup)
airflow variables set lattice_gmail_tenant_id personal
airflow variables set lattice_gmail_account_id personal-gmail
airflow variables set lattice_gmail_alias inbox

# Unpause to start catchup
airflow dags unpause lattice__gmail_backfill
```

### lattice__imap_backfill (catchup-based)
- Schedule: `@daily` with `catchup=True`
- Configuration via Airflow Variables:
  - `lattice_imap_tenant_id` (default: `personal`)
  - `lattice_imap_account_id` (default: `personal-imap`)
  - `lattice_imap_alias` (default: `inbox`)
  - `lattice_imap_source_folder` (default: `INBOX`)
- Backfill window: set `BACKFILL_START_DATE` and `BACKFILL_END_DATE` in DAG file
- Processing: loops internally with batch size 100 until day is exhausted
- Idempotency: searches source folder only, moves to `Lattice/{alias}` after processing
- Sequential: `depends_on_past=True` ensures days process in order
- Does not update incremental sync watermark

**Usage:**
```bash
# Set variables (optional if defaults match your setup)
airflow variables set lattice_imap_tenant_id personal
airflow variables set lattice_imap_account_id personal-imap
airflow variables set lattice_imap_alias inbox
airflow variables set lattice_imap_source_folder INBOX

# Unpause to start catchup
airflow dags unpause lattice__imap_backfill
```

### lattice__retention_sweep
- Schedule: daily; supports conf overrides and a `force` flag.
- Cursoring: stable tuple comparison `(received_at, id)` for pagination and resumption.
- Publishes deletion requests with **envelope wrapper** and explicit payload duplication of tenant/account for downstream validation.
- Checkpoints every 100 publishes (flush + update sweep cursor).

---

## Environment and Dependencies (Where Failures Usually Come From)

### Shared service dependencies used by the DAG task logic
- Postgres (account registry + watermarks + retention tables)
- Object storage (MinIO/S3 via `lattice_storage`)
- Kafka (producer optional depending on env)

### Provider credentials
- Gmail connector uses env:
  - `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER_EMAIL`
- IMAP connector uses env:
  - `IMAP_HOST`, `IMAP_PORT`, `IMAP_USERNAME`, `IMAP_PASSWORD`

### Airflow Variables (for backfill DAGs)
- Gmail: `lattice_gmail_tenant_id`, `lattice_gmail_account_id`, `lattice_gmail_alias`
- IMAP: `lattice_imap_tenant_id`, `lattice_imap_account_id`, `lattice_imap_alias`, `lattice_imap_source_folder`

---

## Where to Look First When Something Breaks

### Symptoms → likely root cause mapping

1) "No new messages ingested"
- Watermark advanced too far? (Gmail historyId / IMAP last_uid)
- Provider post-processing failing (label/move) can block watermark advance
- Producer disabled (no bootstrap servers), so you see storage writes but no Kafka publish

2) "Messages stored but not picked up by workers"
- Kafka publish did not happen (producer None or publish error)
- Topic mismatch: workers consume `lattice.mail.raw.v1`—verify publish target is the same topic (raw)

3) "Retention sweep runs but nothing deletes"
- Eligible selection returns empty due to cutoff/filters
- Sweep is already completed and not forced (idempotency short-circuit)
- Deletion requests not published (Kafka failure / envelope invalid)

4) "mail-deleter DLQ: ENVELOPE_INVALID / PARSE_ERROR"
- Ensure retention sweep uses `publish_envelope(...)` and payload includes tenant/account duplication (expected by worker).

5) "Backfill DAG running but tasks not executing"
- DAG may be paused (new DAGs are paused by default)
- Check `depends_on_past=True` — if a previous day failed, subsequent days won't run
- Verify Airflow Variables are set correctly

6) "Backfill processes same messages repeatedly"
- Gmail: label application failing? Check Gmail API errors
- IMAP: folder move failing? Check IMAP connection/permissions
- Idempotency marker not being applied

7) "Backfill stuck on one day"
- Check task logs for errors in the loop
- May be hitting Gmail API rate limits (add backoff/retry)
- IMAP connection timeout during large batch

---

## How to Debug (Repeatable Checklist)

### For Incremental Sync (Gmail/IMAP):
1. Confirm account is enabled in Postgres (AccountRegistry list)
2. Confirm watermark state (WatermarkStore)
3. Confirm object storage write succeeded (URI returned)
4. Confirm Kafka producer exists and publish succeeded
5. Confirm provider post-processing succeeded (label/move)
6. Confirm watermark advanced only when expected

### For Backfill:
1. Confirm DAG is unpaused: `airflow dags list | grep backfill`
2. Confirm Airflow Variables are set: `airflow variables list`
3. Confirm backfill window (`BACKFILL_START_DATE`, `BACKFILL_END_DATE`) is correct in DAG file
4. Check task logs for the specific execution_date
5. Confirm idempotency markers are being applied (Gmail labels / IMAP folder)
6. If stuck, check if `depends_on_past=True` is blocking due to prior failure
7. Verify credentials (GMAIL_* or IMAP_* env vars) are set in Airflow environment

### For Retention:
1. Confirm params (cutoff_date, max_emails_per_run) validated correctly
2. Confirm sweep_run status (completed/running/failed) and force semantics
3. Confirm eligible selection query and tuple cursor logic
4. Confirm Kafka publish_envelope is used and checkpointing updates cursor
5. Confirm downstream mail-deleter consumption + completion topic/audit

---

## Guardrails (Do Not Violate)

- Do not log message contents, subjects, addresses, or raw bodies from Airflow.
- Do not advance watermarks unless *store + publish + post-process* completed.
- Do not make Airflow delete directly; publish deletion requests and let workers execute.
- Keep the shared logic centralized in `lattice_mail_tasks.py`; DAG files should stay thin wrappers.
- Backfill DAGs must never modify incremental sync watermarks.
- Idempotency markers (labels/folders) must be applied AFTER successful store + publish.

---

## Backfill Operations Reference

### Adjusting Backfill Window
Edit the DAG file directly:
```python
BACKFILL_START_DATE = datetime(2024, 1, 1)   # Start of backfill
BACKFILL_END_DATE = datetime(2024, 12, 31)   # End of backfill
```

### Reprocessing a Specific Day
1. Clear the task instance for that date in Airflow UI
2. Or use CLI: `airflow tasks clear lattice__gmail_backfill -s 2024-04-15 -e 2024-04-15`

### Pausing/Resuming Backfill
```bash
# Pause (stop processing new days)
airflow dags pause lattice__gmail_backfill

# Resume
airflow dags unpause lattice__gmail_backfill
```

### Monitoring Progress
- Airflow UI: shows completed/running/failed runs by date
- Each run logs: `messages_fetched`, `messages_stored`, `messages_published`, `messages_labeled`, `batches_processed`
- Final batch will show `Partial batch received (N < 100), day complete`

### Batch Size Configuration
Default is 100 messages per internal loop iteration. To adjust:
```python
BATCH_SIZE = 100  # Messages per loop iteration
MAX_BATCHES_PER_RUN = None  # None = unlimited, or set integer limit
```
