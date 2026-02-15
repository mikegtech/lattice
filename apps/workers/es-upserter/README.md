# ES Upserter Worker

Kafka consumer that indexes embedded email chunks to Elasticsearch Cloud for full-text + vector search.

## Architecture

```
lattice.mail.embed.v1
    ├── mail-upserter-group  → ALL chunks → Milvus    (existing)
    └── es-upserter-group    → filter(alias) → Elasticsearch Cloud  (this worker)
```

The es-upserter is a **second consumer** on `lattice.mail.embed.v1` using its own consumer group (`es-upserter-group`). Every embedded chunk is delivered to both consumers independently by Kafka. The es-upserter applies an alias filter so only emails matching a configurable pattern are indexed to Elasticsearch.

## Alias Filter

The `ES_UPSERTER_ALIAS_PATTERN` environment variable controls which emails are indexed:

- `realty-*@woodcreek.me` — only index emails for aliases matching this glob pattern
- Unset/empty — index **all** emails (no filtering)

The filter uses glob-style matching with a single `*` wildcard, case-insensitive. Filtered messages are skipped cheaply without any ES or embedding calls.

## Topics

| Direction | Topic | Description |
|-----------|-------|-------------|
| Input | `lattice.mail.embed.v1` | Embedded chunks (shared with mail-upserter) |
| Output | `lattice.es.upsert.v1` | Confirmation of ES indexing |
| DLQ | `lattice.dlq.es.upsert.v1` | Failed messages |

## Setup

```bash
# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env
# Edit .env with your Elasticsearch Cloud credentials

# Development
pnpm dev

# Run tests
pnpm test

# Build
pnpm build
```

## Environment Variables

See `.env.example` for all configuration options. Key variables:

- `ELASTICSEARCH_CLOUD_ID` — Elastic Cloud deployment ID
- `ELASTICSEARCH_API_KEY` — Elastic Cloud API key
- `ELASTICSEARCH_INDEX` — Target index name (default: `email_chunks_v1`)
- `ES_UPSERTER_ALIAS_PATTERN` — Glob pattern for alias filtering
- `KAFKA_GROUP_ID` — Must be `es-upserter-group` (separate from mail-upserter)
