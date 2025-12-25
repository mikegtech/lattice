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
