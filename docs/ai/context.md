# Lattice – AI Context Anchor

This document is the canonical **rehydration anchor** for AI tools
(Claude Code, Cursor, Kiro) and humans.

If an AI session restarts, this file defines:
- where the system is
- what is done
- what must not be changed
- what phase is active

---

## Current Phase
**Phase 5 – Embedding (mail-embedder)**

---

## Completed Phases

### Phase 0 – Architecture & Governance
- Event-driven architecture (Kafka-first)
- Airflow is orchestration only
- NestJS is the standard worker framework
- Provider-neutral ingestion (Gmail API + IMAP)
- Alias-based routing model
- CI policy gate enforced (`policy.yml`)
- CODEOWNERS defined
- Role-based instructions under `.github/instructions/`

### Phase 1 – Contracts & Core Data Model
- Kafka envelope extended with provider + account + alias
- `lattice.mail.raw.v1` supports Gmail and IMAP
- Postgres tables:
  - `mail_accounts`
  - `mail_watermarks`

### Phase 2 – Connectors & Raw Event Production
- Gmail API connector
- Amazon WorkMail IMAP connector
- MinIO / S3-compatible object storage
- Kafka producer for `lattice.mail.raw.v1`
- Alias post-processing:
  - Gmail → label `Lattice/<alias>`
  - IMAP → move to folder `<alias>`

### Phase 3 – Airflow Orchestration
- Incremental DAGs:
  - `lattice__gmail_sync_incremental`
  - `lattice__imap_sync_incremental`
- Backfill DAGs (date-controlled):
  - `lattice__gmail_backfill`
  - `lattice__imap_backfill`
- 1-to-many accounts per provider
- Watermarks updated only after successful post-processing
- IMAP watermark advances only to last successfully processed UID

### Phase 4 – Chunking
- NestJS worker `mail-chunker` implemented
- Running locally via `lattice-workers.yml`
- Pipeline validated:
  `raw → parse → chunk`
- Postgres FTS populated for chunks
- Deterministic chunk hashing enforced

---

## Active Phase

### Phase 5 – Embedding
**Goal:** Convert chunks into embeddings in a controlled, versioned, idempotent way.

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

---

## Local Runtime Topology

- `lattice-core.yml` → Postgres, Milvus, MinIO
- `airflow.yml` → Airflow
- `lattice-workers.yml` → Kafka workers:
  - mail-parser
  - mail-chunker
  - (next) mail-embedder

---

## Rehydration Instructions for AI Tools

When starting a new AI session:
1. Read this file
2. Read `docs/architecture/`
3. Read `docs/runbooks/`
4. Read `.github/instructions/*.md`
5. Ask what phase is active before making changes

This file overrides chat history.
