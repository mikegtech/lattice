# Local Docker Compose Layout

This directory contains **purpose-scoped Docker Compose files**.
There is intentionally no root-level docker-compose.yml.

## Files

| File | Services |
|------|----------|
| `lattice-core.yml` | PostgreSQL, Milvus, MinIO, Airflow |
| `lattice-workers.yml` | mail-parser, mail-chunker, mail-embedder, mail-upserter |
| `datadog.yml` | Datadog Agent (logs, metrics, traces) |

## Quick Start

### 1. Start core infrastructure
```bash
docker compose -f lattice-core.yml up -d
```

### 2. Start workers (requires core network)
```bash
docker compose -f lattice-core.yml -f lattice-workers.yml up -d mail-parser mail-chunker mail-embedder mail-upserter
```

### 3. (Optional) Start Datadog
```bash
docker compose -f datadog.yml up -d
```

## Workers

| Worker | Input Topic | Output Topic | Port | Description |
|--------|------------|--------------|------|-------------|
| mail-parser | `lattice.mail.raw.v1` | `lattice.mail.parse.v1` | 3100 | Parses raw RFC822 emails |
| mail-chunker | `lattice.mail.parse.v1` | `lattice.mail.chunk.v1` | 3101 | Chunks emails for embedding |
| mail-embedder | `lattice.mail.chunk.v1` | `lattice.mail.embed.v1` | 3102 | Generates embeddings |
| mail-upserter | `lattice.mail.embed.v1` | `lattice.mail.upsert.v1` | 3103 | Upserts vectors to Milvus |

### Build workers
```bash
docker compose -f lattice-workers.yml build
```

### View logs
```bash
docker compose -f lattice-workers.yml logs -f mail-parser mail-chunker mail-embedder mail-upserter
```

### Health checks
```bash
curl http://localhost:3100/health  # mail-parser
curl http://localhost:3101/health  # mail-chunker
curl http://localhost:3102/health  # mail-embedder
curl http://localhost:3103/health  # mail-upserter
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

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description |
|----------|-------------|
| `KAFKA_BROKERS` | Kafka bootstrap servers |
| `KAFKA_SASL_USERNAME` | Confluent Cloud API key |
| `KAFKA_SASL_PASSWORD` | Confluent Cloud API secret |
| `POSTGRES_PASSWORD` | PostgreSQL password |

## Network

All services share the `lattice-network` bridge network.
Workers reference this network as external when run standalone.
