# Mail Chunker Worker

NestJS Kafka worker that chunks parsed emails into embedding-ready segments.

## Overview

The mail-chunker worker:
1. Consumes parsed emails from `lattice.mail.parse.v1`
2. Fetches canonical normalized text from Postgres
3. Splits content into semantic sections (body, signature, quotes)
4. Chunks each section with token-aware splitting and overlap
5. Persists chunks to `email_chunk` table
6. Emits chunk events to `lattice.mail.chunk.v1`

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ lattice.mail.   │────▶│   mail-chunker   │────▶│ lattice.mail.   │
│ parse.v1        │     │     worker       │     │ chunk.v1        │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                         ┌──────────┐
                         │ Postgres │
                         │ email_   │
                         │ chunk    │
                         └──────────┘
```

## Chunking Algorithm

### Token-Aware Splitting
- Target chunk size: 350-450 tokens (configurable)
- Overlap: 50 tokens between chunks for context
- Preserves paragraph and sentence boundaries where possible

### Section Classification
- **body**: Main email content
- **greeting**: Opening salutation
- **signature**: Email signature block
- **quote**: Quoted previous messages (skipped by default)
- **attachment_text**: Extracted attachment content

### Deterministic Hashing
Chunk hash is calculated as:
```
sha256(chunk_text + normalization_version + chunking_version)
```

This ensures:
- Same input → same hash (deterministic)
- Algorithm changes → new hash (version-aware)
- Idempotent reprocessing

## Idempotency

The worker checks for existing chunks before processing:
1. Query `email_chunk` for `(email_id, chunking_version, normalization_version)`
2. If chunks exist, ACK message and emit nothing
3. If new version, create new chunks (old versions remain)

## Running Locally

### Prerequisites
- Docker + Docker Compose (for Kafka, Postgres)
- Node.js 20+
- pnpm

### Setup

1. Start infrastructure:
```bash
cd /path/to/lattice
pnpm docker:up
```

2. Run migrations:
```bash
# Connect to Postgres and run migrations
# pragma: allowlist secret
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/lattice"
psql "$DATABASE_URL" -f infra/local/postgres/migrations/001_initial_schema.sql
psql "$DATABASE_URL" -f infra/local/postgres/migrations/002_chunk_versioning.sql
```

3. Configure environment:
```bash
cd apps/workers/mail-chunker
cp .env.example .env
# Edit .env if needed
```

4. Install dependencies:
```bash
pnpm install
```

5. Run in development mode:
```bash
pnpm dev
```

### Running Tests

```bash
pnpm test        # Run tests once
pnpm test:watch  # Watch mode
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHUNK_TARGET_TOKENS` | `400` | Target chunk size in tokens |
| `CHUNK_OVERLAP_TOKENS` | `50` | Overlap between chunks |
| `CHUNK_MAX_TOKENS` | `512` | Maximum chunk size |
| `CHUNKING_VERSION` | `v1` | Algorithm version |
| `NORMALIZATION_VERSION` | `v1` | Text normalization version |

See `.env.example` for full configuration.

## Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `messages.received` | counter | Messages consumed |
| `messages.success` | counter | Successfully processed |
| `messages.skipped` | counter | Skipped (duplicate/empty) |
| `messages.error` | counter | Processing errors |
| `chunks.created` | counter | Chunks generated |
| `chunking_time_ms` | histogram | Chunking duration |
| `db.insert_ms` | histogram | Database insert time |

## Health Endpoints

- `GET /health/live` - Liveness probe
- `GET /health/ready` - Readiness probe
- `GET /health` - Full status

Default port: 3001

## TODO

- [ ] Integrate actual tokenizer (tiktoken) for accurate token counts
- [ ] Add attachment text chunking (pending extraction pipeline)
- [ ] Add configurable quote inclusion
- [ ] Add chunk quality metrics
