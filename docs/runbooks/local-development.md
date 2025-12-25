Excellent timing to do this. What you’re asking for now is **institutional memory**: a small, intentional documentation set that (a) keeps humans aligned, and (b) gives *any* AI tool a reliable rehydration anchor.

Below is a **complete, minimal-but-intentional documentation set**, all in **Markdown**, followed by the **Phase 5 Claude prompt**, updated to reflect that **mail-chunker is already running in `lattice-workers.yml`**.

You can copy these files verbatim into your repo.

---

# 1️⃣ `docs/ai/context.md`

**Single source of truth for rehydration**

```markdown
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
```

---

# 2️⃣ `docs/architecture/README.md`

**Architecture index**

```markdown
# Lattice Architecture

This directory documents architectural decisions and system structure.

## Files

- `scope-v1.md`
  Overall system scope and boundaries.

- `worker-template.md`
  Standard NestJS Kafka worker template and invariants.

- `adr/`
  Architecture Decision Records (ADRs).

- `mail-sources.md`
  Provider model (Gmail API + IMAP).

---

## Architectural Principles

- Event-driven, Kafka-first
- Provider-neutral ingestion
- Idempotency at every stage
- Separation of control-plane (Airflow) and data-plane (workers)
- Observable by default (Datadog)

All new changes must align with these principles.
```

---

# 3️⃣ `docs/architecture/scope-v1.md`

**(Condensed, intentional scope)**

```markdown
# Lattice – Scope v1

## Purpose
Ingest email from multiple providers (Gmail API, IMAP),
normalize it, chunk it, embed it, and prepare it for vector search.

---

## In Scope
- Gmail API ingestion
- Amazon WorkMail IMAP ingestion
- Multiple accounts per provider
- Alias-based routing
- Incremental sync and date-controlled backfill
- Postgres (system-of-record)
- Milvus (vector store)
- Airflow orchestration
- Kafka workers (NestJS)

---

## Out of Scope (v1)
- UI
- User-facing APIs
- Authorization beyond service credentials
- Cloud deployment (GCP is Phase 8)

---

## Pipeline Stages
1. Raw ingestion → `lattice.mail.raw.v1`
2. Parsing → `lattice.mail.parse.v1`
3. Chunking → `lattice.mail.chunk.v1`
4. Embedding → `lattice.mail.embed.v1`
5. Vector upsert → `lattice.mail.upsert.v1`

---

## Success Criteria
- Idempotent ingestion
- No duplicate processing
- Deterministic chunking and embeddings
- Full local validation before cloud deployment
```

---

# 4️⃣ `docs/runbooks/README.md`

**Runbook index**

```markdown
# Lattice Runbooks

Operational and developer runbooks.

## Contents

- `demo-two-inboxes-airflow.md`
  End-to-end Gmail + IMAP demo.

- `test-phase-3.md`
  Validation checklist for Airflow ingestion.

- `local-development.md`
  How to run Lattice locally.

Each runbook is executable and step-by-step.
```

---

# 5️⃣ `docs/runbooks/local-development.md`

```markdown
# Local Development – Lattice

## Startup Order

```bash
docker compose -f lattice-core.yml up -d
docker compose -f airflow.yml up -d
docker compose -f lattice-workers.yml up -d
````

## Verify Services

* Postgres reachable
* Airflow UI available
* mail-parser and mail-chunker healthy
* Kafka connectivity OK

## Logs

Use Datadog or `docker logs lattice-mail-parser` etc.

## Shutdown

```bash
docker compose down
```

```

---

# 6️⃣ `docs/runbooks/test-phase-3.md`
**Airflow ingestion validation**

```markdown
# Phase 3 Validation Checklist

## Gmail Backfill
Trigger:
```bash
airflow dags trigger lattice__gmail_backfill \
  --conf '{"tenant_id":"personal","account_id":"personal-gmail","start_date":"2024-01-01","end_date":"2024-01-02","limit_per_run":5}'
```

Verify:

* Kafka `lattice.mail.raw.v1` populated
* Gmail label `Lattice/<alias>` applied
* mail-parser consumes events

## IMAP Backfill

Trigger:

```bash
airflow dags trigger lattice__imap_backfill \
  --conf '{"tenant_id":"personal","account_id":"workmail-imap","folder":"INBOX","start_date":"2024-01-01","end_date":"2024-01-02","limit_per_run":5}'
```

Verify:

* Messages moved to alias folder
* Raw events published

## Incremental

* Let incremental DAGs run twice
* Verify no duplicates
* Verify watermarks advance correctly

```

---

# 7️⃣ Phase 5 Claude Prompt (Embedding)

```text
You are working in the “lattice” monorepo on main.

Rehydrate context:
- Read docs/ai/context.md
- Read docs/architecture/*
- Read docs/runbooks/*
- Read .github/instructions/*.md

Current phase: Phase 5 – Embedding.

mail-chunker is already implemented and running via lattice-workers.yml.

Objective:
Implement the NestJS Kafka worker `mail-embedder`.

Worker:
- Name: mail-embedder
- Service: lattice-worker-mail-embedder
- Domain: mail
- Stage: embed
- Framework: NestJS (use worker template)
- Kafka: KafkaJS via core-kafka
- Telemetry: core-telemetry (no PII)

Topics:
- Input: lattice.mail.chunk.v1
- Output: lattice.mail.embed.v1
- DLQ: lattice.dlq.mail.embed.v1

Responsibilities:
1) Consume chunk events and validate envelope/schema.
2) Idempotency:
   - Do not re-embed the same (chunk_hash, embedding_version).
3) Fetch chunk_text from Postgres.
4) Embed:
   - Implement embedding provider abstraction.
   - Local provider is acceptable for v1.
   - Support batching and rate limiting.
5) Persist embedding metadata in Postgres:
   - embedding_model_id
   - embedding_version
   - vector_dim
   - embedded_at
6) Publish lattice.mail.embed.v1 with references to stored embeddings.
7) DLQ on non-retryable failures.
8) Add mail-embedder to lattice-workers.yml.
9) Tests:
   - idempotency
   - batch behavior
   - DLQ behavior

Constraints:
- Do NOT upsert to Milvus yet (Phase 6).
- Do NOT modify Airflow DAGs.
- Keep CI green.

After implementation:
- Summarize changes
- Provide local test steps
```

---

## Final confirmation

You now have:

* A **single, authoritative rehydration anchor**
* Intentional architecture docs (not fluff)
* Executable runbooks
* A clean governance story across IDEs
* A Phase 5 prompt aligned with your actual runtime (`mail-chunker` already running)

If you want, next we can:

* Add **CI checks that enforce doc presence per phase**
* Design **Phase 6 (Milvus upsert)** with rollback semantics
* Or do a **pre-Phase-5 readiness check** on Postgres schema for embeddings
