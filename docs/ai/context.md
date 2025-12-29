# Lattice – AI Context Anchor

This document is the canonical **rehydration anchor** for AI tools
(Claude Code, Cursor, Kiro) and humans.

If an AI session restarts, this file defines:
- where the system is
- what is completed
- what must not be changed
- what phase is active
- what files are safe to modify

This file overrides chat history.

---

## Current Phase
**Stabilization – Testing & Bug Fixes**

---

## Completed Phases

### Phase 0 – Architecture & Governance (COMPLETE)
- Event-driven architecture (Kafka-first)
- Airflow is orchestration only (control plane)
- NestJS is the standard worker framework
- Provider-neutral ingestion model
- Alias-based routing model
- CI policy gate enforced (`policy.yml`)
- CODEOWNERS defined
- Role-based instructions under `.github/instructions/`

### Phase 1 – Contracts & Core Data Model (COMPLETE)
- Kafka envelope extended with provider, account_id, alias
- `lattice.mail.raw.v1` supports Gmail API and IMAP
- Postgres core tables:
  - `mail_accounts`
  - `mail_watermarks`

### Phase 2 – Connectors & Raw Event Production (COMPLETE)
- Gmail API connector
- Amazon WorkMail IMAP connector
- MinIO / S3-compatible object storage
- Kafka producer for `lattice.mail.raw.v1`
- Alias post-processing:
  - Gmail → label `Lattice/<alias>`
  - IMAP → move to folder `<alias>`

### Phase 3 – Airflow Orchestration (COMPLETE)
- Incremental DAGs:
  - `lattice__gmail_sync_incremental`
  - `lattice__imap_sync_incremental`
- Backfill DAGs (date-controlled):
  - `lattice__gmail_backfill`
  - `lattice__imap_backfill`
- 1-to-many accounts per provider
- Watermarks advance only after successful post-processing
- IMAP watermark advances only to last successfully processed UID
- Retention sweep DAG implemented and hardened

### Phase 4 – Chunking (COMPLETE)
- NestJS worker `mail-chunker` implemented
- Running locally via `lattice-workers.yml`
- Pipeline validated:
  `raw → parse → chunk`
- Postgres FTS populated for chunks
- Deterministic chunk hashing enforced

### Phase 5 – Embedding (COMPLETE)
- NestJS worker `mail-embedder` implemented
- Pipeline extended:
  `raw → parse → chunk → embed`
- Embedding is versioned and idempotent:
  - embeddings keyed by (email_id, chunk_hash, embedding_version)
- Embeddings and metadata persisted in Postgres (system-of-record)
- Embed events published to `lattice.mail.embed.v1`

### Phase 6 – Vector Upsert (COMPLETE)
- NestJS worker `mail-upserter` implemented
- Vectors upserted to Milvus (idempotent, versioned)
- Full pipeline validated:
  `raw → parse → chunk → embed → upsert`
- Upsert events published to `lattice.mail.upsert.v1`

### Phase 7 – Retention Sweep (COMPLETE)
- Airflow DAG `lattice__retention_sweep` implemented
- Identifies emails by cutoff date for deletion
- Publishes deletion requests to Kafka (`lattice.mail.delete.v1`)
- Resumable via `retention_sweep_run` table with tuple cursor

### Phase 8 – Mail Deletion & Audit (COMPLETE)
- NestJS worker `mail-deleter` implemented
- Deletes from Milvus (vectors) and Postgres (records)
- Supports: single_email, account, alias, retention_sweep deletion types
- Audit events published to `lattice.audit.events.v1`
- NestJS worker `audit-writer` consumes and persists audit events

### Phase 9 – Datadog Observability Infrastructure (COMPLETE)
- Terraform-managed Datadog configuration (`infra/datadog/`)
- Log pipeline with tier-aware processing
- Log-based metrics for performance monitoring:
  - `lattice.processing.duration_ms` (distribution)
  - `lattice.dlq.count` (count by error_code)
  - `lattice.messages.processed` (count by stage)
  - `lattice.errors.count` (count by service)
- Detection rules (17 monitors):
  - DLQ monitors (spike, schema errors, critical volume)
  - Error rate monitors (high rate, sustained, spike)
  - Availability monitors (no logs, shutdown, restarts)
  - Kafka connectivity monitors (connection errors, timeouts, all disconnected)
  - Performance monitors (latency P95, throughput drop)
  - Deployment monitors (success/failure events)
- Comprehensive dashboard ("Lattice Worker Health")
- GitHub Actions workflow for Terraform CI/CD (`terraform-datadog.yml`)
- All notifications flow through Datadog (no direct Slack webhooks)
- GCS backend for Terraform state

---

---

## Stabilization Rules
During stabilization phase:
- No new features without explicit approval
- Minimal diffs preferred
- Update runbooks when changing runtime behavior
- Keep CI policy checks green
- Fix bugs and align docs before adding scope

---

## Core Invariants (DO NOT VIOLATE)
- Airflow orchestrates; workers execute
- Kafka topics are the system boundary
- Postgres is the system-of-record
- Workers are idempotent
- Watermarks advance only after full success
- No PII in logs
- No secrets in repo
- Local validation via Docker Compose is required before cloud deployment
- Metric tags must be low-cardinality per `docs/telemetry-tags.md`

---

## Local Runtime Topology
- `infra/local/compose/lattice-core.yml` → Postgres, Milvus, MinIO, Airflow
- `infra/local/compose/lattice-workers.yml` → Kafka workers:
  - mail-parser
  - mail-chunker
  - mail-embedder
  - mail-upserter
  - mail-extractor
  - attachment-chunker
  - mail-deleter
  - audit-writer

---

## Rehydration Instructions for AI Tools
When starting a new AI session:
1. Read this file
2. Read `docs/architecture/`
3. Read `docs/runbooks/`
4. Read `.github/instructions/*.md`
5. Confirm the current phase before making changes

This file overrides chat history.
