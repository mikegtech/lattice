# Lattice

Event-driven email indexing pipeline for Gmail with semantic search capabilities.

## Overview

Lattice is a governed, observable pipeline that:
- Ingests emails from Gmail (including attachments)
- Parses, chunks, and embeds email content
- Stores in Postgres (system of record) with full-text search
- Indexes vectors in Milvus for semantic search
- Emits audit events for compliance

## Architecture

```
Gmail API → Airflow → Kafka → Workers → Postgres/Milvus
                         ↓
                    Datadog (observability)
```

### Components

| Component | Purpose |
|-----------|---------|
| **Airflow** | Orchestrates sync (incremental/backfill) |
| **Kafka (Confluent Cloud)** | Event backbone |
| **mail-parser** | Parses raw emails, stores in Postgres |
| **mail-chunker** | Splits text into chunks (planned) |
| **mail-embedder** | Generates embeddings (planned) |
| **mail-upserter** | Upserts to Milvus (planned) |
| **Postgres** | System of record + FTS |
| **Milvus** | Vector search |
| **Datadog** | Unified observability |

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 8+
- Docker & Docker Compose
- Confluent Cloud account (for Kafka)
- Datadog account (optional, for observability)

### Setup

```bash
# Clone and install
git clone <repo>
cd lattice
pnpm install

# Configure environment
cp infra/local/compose/.env.example infra/local/compose/.env
# Edit .env with your Confluent Cloud and Datadog credentials

# Start local infrastructure
pnpm docker:up

# Build packages
pnpm build
```

### Running Locally

```bash
# Start the mail-parser worker (connects to Confluent Cloud)
cd apps/workers/mail-parser
pnpm dev

# Access Airflow UI
open http://localhost:8080  # admin/admin

# Access Milvus
# Port 19530 for gRPC, 9091 for metrics
```

### Running with Docker

```bash
# Start everything including workers
docker compose -f infra/local/compose/lattice-core.yml up -d

# With Datadog agent
docker compose -f infra/local/compose/lattice-core.yml \
               -f infra/local/compose/datadog.yml up -d
```

## Project Structure

```
lattice/
├── apps/
│   └── workers/              # Kafka workers (TypeScript)
│       └── mail-parser/      # Parses raw emails
├── packages/                 # Shared libraries
│   ├── core-config/          # Configuration management
│   ├── core-telemetry/       # Datadog integration
│   ├── core-kafka/           # Kafka producer/consumer
│   └── core-contracts/       # TypeScript types
├── python/
│   ├── dags/                 # Airflow DAGs
│   └── libs/                 # Python libraries
├── contracts/
│   └── kafka/                # JSON Schema definitions
├── infra/
│   └── local/
│       ├── compose/          # Docker Compose files
│       └── postgres/         # Migrations
└── docs/
    ├── architecture/         # Architecture docs
    └── telemetry-tags.md     # Observability standards
```

## Kafka Topics

| Topic | Purpose |
|-------|---------|
| `lattice.mail.raw.v1` | Raw email payloads from Gmail |
| `lattice.mail.parse.v1` | Parsed emails with metadata |
| `lattice.mail.chunk.v1` | Text chunks ready for embedding |
| `lattice.mail.embed.v1` | Chunks with embeddings |
| `lattice.mail.upsert.v1` | Milvus upsert confirmations |
| `lattice.mail.delete.v1` | Deletion requests |
| `lattice.mail.dlq.v1` | Dead letter queue |
| `lattice.audit.events.v1` | Audit trail |

## Development

### Pre-commit Hooks

This repository uses `pre-commit` for local guardrails including secret detection.

```bash
uv pip install pre-commit
pre-commit install
```

### Secrets Baseline

We use `detect-secrets` to prevent accidental commits of API keys, passwords, and other sensitive data. The `.secrets.baseline` file tracks known false positives so they don't block commits.

To regenerate the baseline (e.g., after adding new false positives):
```bash
detect-secrets scan > .secrets.baseline
```

### Adding a new worker

1. Create directory in `apps/workers/<worker-name>`
2. Copy package.json structure from mail-parser
3. Implement using `@lattice/core-kafka` consumer
4. Add to docker-compose if needed

### Modifying schemas

1. Update JSON Schema in `contracts/kafka/`
2. Update TypeScript types in `packages/core-contracts`
3. Bump schema_version if breaking

### Database migrations

```bash
# Migrations are in infra/local/postgres/migrations/
# They run automatically on container start
```

## Observability

All services emit:
- **Metrics**: DogStatsD to Datadog Agent
- **Logs**: JSON to stdout, collected by Datadog
- **Traces**: dd-trace to Datadog APM

See [docs/telemetry-tags.md](docs/telemetry-tags.md) for tagging standards.

## Configuration

Environment variables:

| Variable | Description |
|----------|-------------|
| `ENV` | Environment (dev/staging/prod) |
| `SERVICE_NAME` | Service identifier |
| `SERVICE_VERSION` | Service version |
| `KAFKA_BOOTSTRAP_SERVERS` | Confluent Cloud bootstrap |
| `KAFKA_SASL_USERNAME` | API key |
| `KAFKA_SASL_PASSWORD` | API secret |
| `POSTGRES_*` | Database connection |
| `DD_API_KEY` | Datadog API key |

## Non-Functional Targets

| Metric | Target |
|--------|--------|
| Incremental sync lag | ≤ 15 minutes (P95) |
| Processing | At-least-once, idempotent |
| Reprocessing | Full backfill/re-embed supported |

## License

Proprietary
