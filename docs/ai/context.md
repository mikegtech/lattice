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

### Phase 10 – Large Email Support & Attachment Extraction  (COMPLETE)

#### Part A: Claim Check Pattern for Large Emails
- Emails > 256 KB: Store raw content in MinIO, reference via `raw_object_uri`
- Emails ≤ 256 KB: Inline `raw_payload` in Kafka message (fast path)
- Maximum email size: 25 MB (matches Gmail limit)
- Kafka message size stays under 1 MB (no broker changes needed)

#### Part B: Attachment Storage & Extraction
- mail-parser stores attachments to MinIO with `storage_uri`
- New worker `mail-extractor` extracts text from:
  - PDF (`application/pdf`)
  - DOCX (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
- Extracted text stored in `email_attachment.extracted_text`
- mail-chunker processes attachment text (code already exists)

**Kafka Topics:**
- `lattice.mail.attachment.v1` – Extraction requests
- `lattice.mail.attachment.extracted.v1` – Extraction complete
- `lattice.dlq.mail.attachment.v1` – Extraction failures

**Worker:**
- `mail-extractor` – Text extraction from PDF/DOCX

**Size Limits:**
| Limit | Value |
|-------|-------|
| Max email size | 25 MB |
| Max attachment size | 25 MB |
| Inline threshold | 256 KB |
| Kafka message max | 1 MB (unchanged) |

### Phase 11 – OCR Service (COMPLETE)

#### Part A: Shared OCR Worker
- NestJS worker `ocr-worker` for text extraction from images and scanned PDFs
- Tesseract OCR engine (English only, `-l eng`)
- Handles:
  - Images: JPEG, PNG, TIFF, WebP, GIF, BMP
  - Scanned PDFs (converted via `pdftoppm`)
  - ZIP archives masquerading as PDFs (magic byte detection)
- Claim-check pattern: extracted text stored in MinIO (`lattice-ocr-results` bucket)
- Metadata stored in Postgres (`ocr_result` table) for idempotency
- Standalone deployment: `infra/local/compose/lattice-ocr.yml`

#### Part B: Mail OCR Normalizer
- NestJS worker `mail-ocr-normalizer` bridges OCR results to mail pipeline
- Filters by `source.service === "mail-extractor"`
- Fetches text from MinIO `text_uri`
- Emits to `lattice.mail.attachment.text.v1` with `extraction_source: "ocr"`
- Runs in `lattice-workers.yml` (lightweight, I/O only)

#### Part C: Integration
- `mail-extractor` routes OCR-needed attachments via `needs_ocr` flag
- OCR requests include `source.service` and `correlation_id` for routing
- `attachment-chunker` unchanged - consumes unified `attachment.text.v1` topic

**Architecture:**
```
mail-extractor (needs_ocr=true)
       │
       ▼
lattice.ocr.request.v1
       │
       ▼
┌──────────────────────────┐
│      ocr-worker          │  ← Standalone (lattice-ocr.yml)
│  └─ Tesseract → MinIO    │
└──────────────────────────┘
       │
       ▼
lattice.ocr.result.v1 (text_uri reference)
       │
       ▼
┌──────────────────────────┐
│  mail-ocr-normalizer     │  ← With mail workers (lattice-workers.yml)
│  └─ Fetch text → Emit    │
└──────────────────────────┘
       │
       ▼
lattice.mail.attachment.text.v1
       │
       ▼
attachment-chunker (unchanged)
```

**Kafka Topics:**
- `lattice.ocr.request.v1` – OCR requests (from any service)
- `lattice.ocr.result.v1` – OCR results with `text_uri`
- `lattice.dlq.ocr.v1` – Failed OCR requests
- `lattice.dlq.mail.ocr-normalizer.v1` – Failed normalizations

**Infrastructure:**
- MinIO bucket: `lattice-ocr-results`
- Postgres table: `ocr_result` (migration: `012_ocr_result.sql`)
- Compose file: `infra/local/compose/lattice-ocr.yml`
- Ports: ocr-worker `:3108`, mail-ocr-normalizer `:3109`

**Design Notes:**
- Shared service: `ocr-worker` can serve future domains (property-images, etc.)
- Domain isolation: Each domain has its own normalizer filtering by `source.service`
- Single input topic (`lattice.ocr.request.v1`) with fan-out via normalizers


### Phase 12 – Real Embeddings (COMPLETE)

#### Embedding Provider Abstraction
- New package: `packages/embedding-providers/`
- Factory pattern for runtime provider selection
- Full Datadog telemetry on all providers

#### Providers Implemented

| Provider | Endpoint | Model | Dimensions | Context | Use Case |
|----------|----------|-------|------------|---------|----------|
| **nomic** (default) | `dataops.trupryce.ai:8001` | nomic-embed-text-v1.5 | 768 | 8,192 tokens | Primary |
| **e5** | `dataops.trupryce.ai:8000` | e5-base-v2 | 768 | 512 tokens | Legacy |
| **openai** | API | text-embedding-3-small | 768* | 8,191 tokens | Datadog challenge |
| **vertex-ai** | API | text-embedding-004 | 768 | 2,048 tokens | Alternative |
| **stub** | local | random vectors | configurable | - | Testing |

*OpenAI configured to return 768 dimensions for Milvus compatibility

#### Prefix Conventions (Critical for Search Quality)

| Provider | Indexing (Documents) | Search (Queries) |
|----------|---------------------|------------------|
| Nomic | `search_document: ` | `search_query: ` |
| E5 | `passage: ` | `query: ` |
| OpenAI | none | none |

#### Configuration

```yaml
# mail-embedder environment
EMBEDDING_PROVIDER: nomic  # or e5, openai, vertex-ai, stub
NOMIC_ENDPOINT: http://dataops.trupryce.ai:8001
NOMIC_PREFIX: "search_document: "
E5_ENDPOINT: http://dataops.trupryce.ai:8000
E5_PREFIX: "passage: "
```

#### Telemetry Metrics

```
lattice.embedding.requests{provider, model, success}
lattice.embedding.latency_ms{provider, model, stage}
lattice.embedding.tokens{provider, model}
lattice.embedding.batch_size{provider}
lattice.embedding.cost_usd{provider, model}  # Cloud providers only
```

#### Milvus Collection: `email_chunks_v1`

| Field | Type | Description |
|-------|------|-------------|
| `pk` | VarChar (PK) | `{email_id}:{chunk_hash}:{embedding_version}` |
| `tenant_id` | VarChar | Multi-tenant isolation |
| `account_id` | VarChar | Email account identifier |
| `email_id` | VarChar | Source email UUID |
| `chunk_hash` | VarChar | Deterministic content hash |
| `embedding_version` | VarChar | e.g., "v1" |
| `embedding_model` | VarChar | e.g., "nomic-embed-text-v1.5" |
| `section_type` | VarChar | header, body, attachment_text |
| `email_timestamp` | Int64 | Unix epoch for filtering |
| `vector` | FloatVector(768) | Embedding vector |

**Index:** HNSW with COSINE similarity, M=16, efConstruction=256

#### Verified Working
- HOA document processed through full pipeline
- 6 vectors in Milvus with `embedding_model: nomic-embed-text-v1.5`
- Semantic search returns relevant results

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
- mail-ocr-normalizer `:3109`

### OCR Service (`lattice-ocr.yml`) – Standalone
- ocr-worker `:3108`

### Embedding Services (External)
- Nomic: `dataops.trupryce.ai:8001`
- E5: `dataops.trupryce.ai:8000`

---

## Chunking Configuration

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `CHUNK_TARGET_TOKENS` | 400 | Sweet spot (256-512 recommended) |
| `CHUNK_OVERLAP_TOKENS` | 50 | 12.5% overlap for context |
| `CHUNK_MAX_TOKENS` | 512 | Hard ceiling |
| `CHUNKING_VERSION` | v1 | Idempotency key |
| `NORMALIZATION_VERSION` | v1 | Idempotency key |

---

## Quick Verification Commands

```bash
# Check embedding services
curl http://dataops.trupryce.ai:8001/health  # Nomic
curl http://dataops.trupryce.ai:8000/health  # E5

# Check Milvus vectors
curl -s "http://localhost:9091/api/v1/collection/stats?collection_name=email_chunks_v1" | jq .

# Test semantic search
python3 << 'EOF'
import requests
from pymilvus import connections, Collection

response = requests.post(
    "http://dataops.trupryce.ai:8001/embed",
    json={"texts": ["HOA assessment"], "prefix": "search_query: "}
)
query_vec = response.json()["embeddings"][0]

connections.connect(host="localhost", port="19530")
collection = Collection("email_chunks_v1")
collection.load()

results = collection.search(
    data=[query_vec],
    anns_field="vector",
    param={"metric_type": "COSINE", "params": {"ef": 64}},
    limit=5,
    output_fields=["email_id", "section_type"]
)

for hits in results:
    for hit in hits:
        print(f"Score: {hit.score:.4f} | {hit.entity.get('section_type')}")
EOF
```
---

## Rehydration Instructions for AI Tools
When starting a new AI session:
1. Read this file
2. Read `docs/architecture/`
3. Read `docs/runbooks/`
4. Read `.github/instructions/*.md`
5. Confirm the current phase before making changes

This file overrides chat history.
