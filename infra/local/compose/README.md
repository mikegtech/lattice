# Local Docker Compose Layout

This directory contains **purpose-scoped Docker Compose files**.
There is intentionally no root-level docker-compose.yml.

## Files

| File | Services |
|------|----------|
| `lattice-core.yml` | PostgreSQL, Milvus, MinIO, Airflow |
| `lattice-workers.yml` | mail-parser, mail-chunker, mail-embedder, mail-upserter, mail-extractor, attachment-chunker, mail-ocr-normalizer, mail-deleter, audit-writer |
| `lattice-ocr.yml` | ocr-worker (standalone OCR service) |
| `newrelic-logging.yml` | New Relic Fluent Bit agent (logs) |
| `datadog.yml` | Datadog Agent (logs, metrics, traces) - optional |

## Quick Start

### 1. Start core infrastructure
```bash
docker compose -f lattice-core.yml up -d
```

### 2. Start workers with New Relic logging
```bash
docker compose -f lattice-core.yml -f lattice-workers.yml -f newrelic-logging.yml up -d
```

### 3. (Optional) Start OCR workers
```bash
docker compose -f lattice-core.yml -f lattice-workers.yml -f lattice-ocr.yml -f newrelic-logging.yml up -d
```

## New Relic Logging (Default)

New Relic log forwarding uses **label-based opt-in**. Only containers with the following label will have their logs forwarded:

```yaml
labels:
  com.newrelic.logs: "true"
```

All worker services in `lattice-workers.yml` and `lattice-ocr.yml` are already labeled.

### Required Environment Variables

Set these in your `.env` file:

```bash
NEW_RELIC_LICENSE_KEY=your-ingest-license-key  # Required for log forwarding
NEW_RELIC_LOG_HOST=log-api.newrelic.com        # US: log-api.newrelic.com, EU: log-api.eu.newrelic.com
LATTICE_ENV=local                              # Environment tag
LOG_LEVEL=info                                 # Fluent Bit log level
```

### How Label Opt-In Works

1. Fluent Bit tails all Docker container logs from `/var/lib/docker/containers`
2. Docker metadata enrichment adds container labels to each log record
3. Labels are flattened: `com.newrelic.logs` → `container_label_com_newrelic_logs`
4. Grep filter keeps only logs where `container_label_com_newrelic_logs` equals `true`
5. Matching logs are forwarded to New Relic Logs API

### Verifying Opt-In

To verify a container is opted-in, check its labels:
```bash
docker inspect lattice-mail-parser --format '{{json .Config.Labels}}' | jq '.["com.newrelic.logs"]'
# Should output: "true"
```

To verify logs are flowing to New Relic:
1. Check Fluent Bit is healthy: `curl http://localhost:2020/api/v1/health`
2. Check Fluent Bit metrics: `curl http://localhost:2020/api/v1/metrics`
3. View logs in New Relic One: Logs → Query for `project:lattice`

## Datadog (Optional)

If you prefer Datadog for observability, you can use the Datadog agent instead:

```bash
# Start with Datadog instead of New Relic
docker compose -f lattice-core.yml -f lattice-workers.yml -f datadog.yml up -d
```

Required environment variable:
```bash
DD_API_KEY=your-datadog-api-key
```

Note: Datadog uses its own label-based collection (`com.datadoghq.ad.logs`), which is already configured on all workers.

## Workers

| Worker | Input Topic | Output Topic | Port | Description |
|--------|------------|--------------|------|-------------|
| mail-parser | `lattice.mail.raw.v1` | `lattice.mail.parse.v1` | 3100 | Parses raw RFC822 emails |
| mail-chunker | `lattice.mail.parse.v1` | `lattice.mail.chunk.v1` | 3101 | Chunks emails for embedding |
| mail-embedder | `lattice.mail.chunk.v1` | `lattice.mail.embed.v1` | 3102 | Generates embeddings |
| mail-upserter | `lattice.mail.embed.v1` | `lattice.mail.upsert.v1` | 3103 | Upserts vectors to Milvus |
| audit-writer | `lattice.audit.events.v1` | *(none - terminal)* | 3104 | Writes audit events to Postgres |
| mail-deleter | `lattice.mail.delete.v1` | `lattice.mail.delete.completed.v1` | 3105 | Handles email lifecycle deletions |
| mail-extractor | `lattice.mail.attachment.v1` | `lattice.mail.attachment.extracted.v1` | 3106 | Extracts text from PDF/DOCX |
| attachment-chunker | `lattice.mail.attachment.text.v1` | `lattice.mail.chunk.v1` | 3107 | Chunks extracted attachment text |
| ocr-worker | `lattice.ocr.request.v1` | `lattice.ocr.result.v1` | 3108 | OCR extraction (Tesseract) |
| mail-ocr-normalizer | `lattice.ocr.result.v1` | `lattice.mail.attachment.text.v1` | 3109 | Bridges OCR results to mail pipeline |

### Build workers
```bash
docker compose -f lattice-workers.yml build
```

### View logs
```bash
docker compose -f lattice-workers.yml logs -f mail-parser mail-chunker mail-embedder mail-upserter audit-writer
```

### Health checks
```bash
curl http://localhost:3100/health  # mail-parser
curl http://localhost:3101/health  # mail-chunker
curl http://localhost:3102/health  # mail-embedder
curl http://localhost:3103/health  # mail-upserter
curl http://localhost:3104/health  # audit-writer
```

## Validating mail-upserter (Milvus Vector Upserts)

After starting the workers, you can verify vectors are being upserted to Milvus:

### 1. Check Milvus collection exists
```bash
# Connect to Milvus container and check collection
docker exec -it lattice-milvus-standalone bash -c "curl http://localhost:9091/healthz"
```

### 2. Query vectors via Milvus API (using pymilvus)
```python
from pymilvus import connections, Collection

connections.connect("default", host="localhost", port="19530")
collection = Collection("email_chunks_v1")
print(f"Entity count: {collection.num_entities}")
```

### 3. Check Postgres for vector_id tracking
```bash
docker exec -it lattice-postgres psql -U lattice -d lattice -c "
SELECT ec.chunk_id, ec.vector_id, ec.embedding_version, ee.embedding_model
FROM email_chunk ec
JOIN email_embedding ee ON ec.chunk_id = ee.chunk_id
WHERE ec.vector_id IS NOT NULL
LIMIT 10;
"
```

### 4. Verify idempotency
Processing the same message twice should result in only one vector per (email_id, chunk_hash, embedding_version). Check the worker logs for "skipping" messages:
```bash
docker logs lattice-mail-upserter 2>&1 | grep -i "already exists"
```

## Querying Audit Events

The audit-writer stores all pipeline events in the `audit_event` table for traceability.

### 1. Query all events for an email
```bash
docker exec -it lattice-postgres psql -U lattice -d lattice -c "
SELECT occurred_at, event_type, entity_type,
       payload_json->>'outcome' as outcome,
       payload_json->'actor'->>'service' as service
FROM audit_event
WHERE entity_id = 'your-email-uuid'
ORDER BY occurred_at;
"
```

### 2. Query events by account
```bash
docker exec -it lattice-postgres psql -U lattice -d lattice -c "
SELECT occurred_at, event_type, entity_id,
       payload_json->>'outcome' as outcome
FROM audit_event
WHERE tenant_id = 'your-tenant-id'
  AND account_id = 'your-account-id'
ORDER BY occurred_at DESC
LIMIT 50;
"
```

### 3. Query events by type (e.g., all parsing events)
```bash
docker exec -it lattice-postgres psql -U lattice -d lattice -c "
SELECT occurred_at, entity_id,
       payload_json->>'outcome' as outcome,
       payload_json->'metrics'->>'duration_ms' as duration_ms
FROM audit_event
WHERE event_type = 'email.parsed'
ORDER BY occurred_at DESC
LIMIT 20;
"
```

### 4. Trace an email through the pipeline
```bash
docker exec -it lattice-postgres psql -U lattice -d lattice -c "
SELECT occurred_at, event_type,
       payload_json->'actor'->>'service' as service,
       payload_json->>'outcome' as outcome
FROM audit_event
WHERE entity_id = 'your-email-uuid'
   OR payload_json->>'email_id' = 'your-email-uuid'
ORDER BY occurred_at;
"
```

### 5. Find failed events
```bash
docker exec -it lattice-postgres psql -U lattice -d lattice -c "
SELECT occurred_at, event_type, entity_id,
       payload_json->'actor'->>'service' as service,
       payload_json->'details'->>'error' as error
FROM audit_event
WHERE payload_json->>'outcome' = 'failure'
ORDER BY occurred_at DESC
LIMIT 20;
"
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description |
|----------|-------------|
| `KAFKA_BROKERS` | Kafka bootstrap servers |
| `KAFKA_SASL_USERNAME` | Confluent Cloud API key |
| `KAFKA_SASL_PASSWORD` | Confluent Cloud API secret |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `NEW_RELIC_LICENSE_KEY` | New Relic ingest license key |
| `NEW_RELIC_LOG_HOST` | `log-api.newrelic.com` (US) or `log-api.eu.newrelic.com` (EU) |
| `LATTICE_ENV` | Environment tag (local, dev, prod) |
| `LOG_LEVEL` | Fluent Bit log level (error, warn, info, debug) |

## Network

All services share the `lattice-network` bridge network.
Workers reference this network as external when run standalone.
