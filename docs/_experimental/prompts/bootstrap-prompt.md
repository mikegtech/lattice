You are working inside a monorepo named “lattice” with role-specific instruction files already present under .github/instructions/.

Objective: implement a runnable v1 vertical slice locally:
- Contract-first Kafka schemas for lattice.mail.* topics (v1)
- TypeScript shared packages: core-config, core-telemetry, core-kafka, core-contracts (generated or simple)
- One Kafka worker service in TypeScript: apps/workers/mail-parser
- Python Airflow DAG skeletons (no heavy logic) that enqueue work to Kafka
- Local Docker Compose: Postgres, Milvus, Airflow, Datadog Agent (workers connect to Confluent Cloud)
- Postgres schema migrations for email + chunks (system of record)
- Datadog unified service tagging and log-trace correlation from day one
- Postgres FTS enabled for email/chunk text
- Gmail API is the source, including attachments, but you can stub the Gmail fetcher for now; focus on the pipeline plumbing and worker correctness.

Repo conventions:
- Node uses pnpm workspace; TS strict; shared code in packages/*
- Python uses uv workspace; Airflow DAGs in python/dags/*
- contracts live in contracts/kafka/** as JSON Schema
- docs in docs/**

Deliverables (make actual commits or at least produce the files):
1) Create the monorepo folder structure and workspace config:
   - pnpm-workspace.yaml, package.json, tsconfig.base.json
   - python pyproject.toml, uv.lock placeholders if needed
2) Define Kafka message envelope schema in contracts/kafka/envelope/v1.json
   Envelope must include: message_id, trace_id (optional but supported), tenant_id, account_id, domain, stage, schema_version, created_at, source, data_classification, pii.
3) Define v1 schemas for these topics under contracts/kafka/mail/**:
   - raw, parse, chunk, embed, upsert, delete; plus dlq schema for embed failures and audit.events schema.
   Include deterministic IDs: provider_message_id, email_id, content_hash, chunk_hash, embedding_version.
4) Implement packages:
   - packages/core-config: typed config loader + validation of required env vars
   - packages/core-telemetry: Datadog tagging helper + logger wrapper; ensure required tags exist; cardinality rules (do not emit high-cardinality tags as metric tags)
   - packages/core-kafka: KafkaJS-based producer/consumer wrapper with:
       - tracing context propagation in headers
       - retry policy
       - DLQ publisher helper
       - schema_version enforcement
   - packages/core-contracts: TypeScript types for the event payloads (can be hand-written initially from the JSON schemas if codegen is too heavy)
5) Implement Postgres migrations:
   - email table with provider_message_id, thread_id, subject, sent_at, received_at, raw_object_uri, text_body, content_hash, fts tsvector
   - email_chunk table with chunk_hash, chunk_text, section_type, embedding_version, vector_id, fts tsvector
   - indexes for account_id, provider_message_id, content_hash, chunk_hash, tsvector indexes
6) Implement worker apps/workers/mail-parser:
   - Consume lattice.mail.raw.v1
   - Parse and normalize (stub parse if needed); store email record in Postgres; update FTS fields
   - Emit lattice.mail.parse.v1
   - Idempotent: if provider_message_id+account_id exists with same content_hash, do nothing except ack
   - Telemetry: logs + metrics + traces with required tags (env/service/version/team/cloud/region/domain/pipeline/stage)
7) Implement python/dags:
   - lattice__mail_sync_incremental: skeleton that would fetch from Gmail and publish raw events (stub fetcher)
   - lattice__mail_backfill: skeleton
   DAG tasks must be lightweight; no embedding or parsing in Airflow.
8) Local compose:
   - infra/local/compose/lattice-core.yml: Postgres, Milvus stack, Airflow services, mail-parser worker
   - infra/local/compose/datadog.yml: Datadog Agent with logs+APM enabled; OpenMetrics scrape for Milvus; Postgres integration
   Workers must connect to Confluent Cloud, so include placeholders for bootstrap servers and SASL credentials in env.
9) docs:
   - docs/telemetry-tags.md: document required tags, optional tags, and cardinality rules
   - docs/architecture/scope-v1.md: ensure it matches Gmail+attachments+Postgres FTS+Milvus+Airflow+Confluent+Datadog; indexing lag target ≤15 minutes P95 incremental

Constraints:
- Do not include real secrets. Use env vars and .env.example.
- Do not log PII (email addresses) or OAuth tokens.
- Keep code production-lean: strong types, errors classified, DLQ wiring.

After generating files, provide a short “How to run locally” section in README.md.
