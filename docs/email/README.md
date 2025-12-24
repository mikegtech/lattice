Below is the updated task list that adds **multi-provider ingestion (Gmail API + IMAP for Amazon WorkMail)** with **1-to-many accounts per provider**, and a **working two-inbox demo**. This is written so you can hand it directly to Claude Code in stages.

---

# Updated Task List: Multi-Provider Mail Ingestion (Gmail + WorkMail IMAP)

## Milestone A — Contracts & Data Model (Provider-neutral)

### A1) Extend event envelope to include provider/source

**Goal:** The downstream pipeline must not care whether the message came from Gmail or IMAP.

**Tasks**

* Ensure your Kafka envelope contains:

  * `source.provider` (`gmail` | `imap`)
  * `source.account_id` (logical inbox id, e.g., `personal-gmail`, `workmail-support`)
  * `source.mailbox` (optional; IMAP folder, Gmail label/search scope)
* Ensure payload contains:

  * `provider_message_id` (normalized)
  * `provider_thread_id` (optional)
  * `received_at`
  * `raw_object_uri`
  * `attachments_manifest[]`

**Acceptance**

* `mail.raw.v1` schema supports both providers without breaking.

### A2) Create Postgres tables for account configuration and watermarks

**Tables**

1. `mail_accounts`

* `tenant_id`
* `account_id` (unique per tenant)
* `provider` (`gmail` | `imap`)
* `enabled` (bool)
* `config_json` (provider-specific details)
* `data_classification` (default `confidential`)
* timestamps

2. `mail_watermarks`

* `tenant_id`
* `account_id`
* `scope` (gmail label/search scope OR imap folder)
* `provider`
* `watermark_json` (provider-specific)
* timestamps

**Provider watermark_json**

* Gmail: `{ "historyId": "123..." }`
* IMAP: `{ "uidvalidity": 9999, "last_uid": 12345 }`

**Acceptance**

* migrations exist; indexes support lookups by tenant/account/scope/provider.

---

## Milestone B — Connector Libraries (Python)

### B1) GmailConnector (API)

**Tasks**

* Implement `python/libs/lattice_mail/connectors/gmail_connector.py`

  * OAuth refresh token flow
  * list new mail via History API when `historyId` exists
  * fall back to `messages.list` query on first run
  * fetch message in `raw` or `full`
  * fetch attachments and store them
  * return a normalized `RawMailEvent` object (provider-neutral)

**Acceptance**

* Given credentials, can fetch N messages, store artifacts, return events.

### B2) ImapConnector (Amazon WorkMail)

**Tasks**

* Implement `python/libs/lattice_mail/connectors/imap_connector.py`

  * Connect via IMAPS (SSL)
  * Configure folders (default: INBOX)
  * Incremental by UID with UIDVALIDITY support:

    * read UIDVALIDITY once per folder
    * if UIDVALIDITY changes → full resync for that folder
    * track `last_uid`
  * Fetch RFC822 raw message bytes
  * Parse attachments list (can be deferred to parser worker if you prefer, but store raw .eml for sure)
  * Store artifacts and return normalized `RawMailEvent`

**Acceptance**

* Given WorkMail IMAP credentials, can fetch messages and store raw artifacts.

### B3) Shared object storage abstraction (MinIO local / GCS later)

**Tasks**

* `python/libs/lattice_storage/object_store.py` for S3-compatible storage (MinIO)
* Path conventions:

  * `tenant/{tenant}/account/{account_id}/provider/{provider}/message/{provider_message_id}/message.eml`
  * attachments under `/attachments/{attachment_id}/{filename}`

**Acceptance**

* Both connectors use the same storage abstraction and produce stable URIs.

### B4) Kafka producer for raw events

**Tasks**

* `python/libs/lattice_kafka/producer.py` for Confluent Cloud SASL_SSL publishing
* Publish `lattice.mail.raw.v1` with correct envelope/tags
* Include trace headers if supported

**Acceptance**

* Can publish raw events for both providers into `lattice.mail.raw.v1`.

---

## Milestone C — Airflow Orchestration (2 providers, N accounts)

### C1) Config-driven account registry

**Goal:** no “one DAG per inbox” sprawl.

**Tasks**

* Add a minimal loader:

  * `python/libs/lattice_mail/account_registry.py`
  * reads enabled accounts from Postgres `mail_accounts`
  * returns account configs grouped by provider

**Acceptance**

* Add 2 accounts (Gmail + IMAP) and Airflow sees them.

### C2) Two provider-specific incremental DAGs (recommended)

Implement:

1. `python/dags/lattice__gmail_sync_incremental.py`

* Fetch enabled Gmail accounts
* For each account: run sync task
* Update watermark (historyId)

2. `python/dags/lattice__imap_sync_incremental.py`

* Fetch enabled IMAP accounts
* For each account: poll folders
* Update watermark (uidvalidity + last_uid per folder)

Use Airflow dynamic task mapping if available; otherwise loop within a task for v1.

**Acceptance**

* Both DAGs run successfully with 1 account each.

### C3) Backfill DAGs (parameterized)

Implement:

1. `python/dags/lattice__gmail_backfill.py`

* params: account_id, start_date, end_date
* query-based paging
* publish raw events

2. `python/dags/lattice__imap_backfill.py`

* params: account_id, folder, start_uid(optional), end_uid(optional)
* full scan paging
* publish raw events

**Acceptance**

* Backfill can ingest a bounded slice for each provider.

---

## Milestone D — Working Example: Two Inboxes End-to-End

### D1) Seed two accounts locally

Create seed script:

* `python/scripts/seed_mail_accounts.py`
* Inserts:

  * tenant_id = `personal`
  * `personal-gmail` provider gmail
  * `workmail-imap` provider imap
* Config JSON includes placeholders for secrets (pulled from env)

**Acceptance**

* One command seeds both accounts in Postgres.

### D2) Local env examples (no secrets committed)

Provide `.env.example` for:

* Airflow Gmail OAuth settings
* Airflow IMAP settings
* Kafka Confluent settings
* MinIO settings

**Acceptance**

* detect-secrets passes; no credential-looking strings.

### D3) Demo runbook

Create:

* `docs/runbooks/demo-two-inboxes.md`

Steps:

1. bring up local core (Postgres, Milvus, MinIO, Datadog)
2. seed accounts
3. run both incremental DAGs once
4. verify `lattice.mail.raw.v1` populated
5. verify mail-parser consumes
6. verify Postgres email rows and FTS are populated

**Acceptance**

* You can demonstrate both providers working in under 30 minutes.

---

# Claude Code Execution Plan (what to run next)

## Stage 1 Prompt (Contracts + DB)

“Add provider-neutral contracts + create mail_accounts and mail_watermarks migrations.”

## Stage 2 Prompt (Connectors + storage + producer)

“Implement GmailConnector and ImapConnector (WorkMail) + MinIO object storage + raw Kafka publisher.”

## Stage 3 Prompt (Airflow DAGs)

“Implement lattice__gmail_sync_incremental and lattice__imap_sync_incremental reading accounts from Postgres + update watermarks.”

## Stage 4 Prompt (Two-inbox demo)

“Add seed script + runbook + .env.example without detect-secrets triggers.”

---

# What you will have at the end

* Two providers feeding the same `lattice.mail.raw.v1`
* One pipeline downstream (parser/chunker/etc.) processing both uniformly
* Repeatable, configuration-driven expansion to N accounts per provider

---

If you want, I will now produce the **exact Claude Code prompt for Stage 1** (contracts + migrations) so you can paste it and begin immediately.
