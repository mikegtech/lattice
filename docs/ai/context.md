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
**Phase 6 – Vector Upsert (mail-upserter)**

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
- Embeddings are versi
