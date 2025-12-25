# Local Docker Compose Layout

This directory contains **purpose-scoped Docker Compose files**.
There is intentionally no root-level docker-compose.yml.

## Files

| File | Services |
|------|----------|
| `lattice-core.yml` | PostgreSQL, Milvus, MinIO, Airflow |
| `lattice-workers.yml` | mail-parser, mail-chunker (future: embedder, upserter) |
| `datadog.yml` | Datadog Agent (logs, metrics, traces) |

## Quick Start

### 1. Start core infrastructure
```bash
docker compose -f lattice-core.yml up -d
```

### 2. Start workers (requires core network)
```bash
docker compose -f lattice-core.yml -f lattice-workers.yml up -d mail-parser mail-chunker
```

### 3. (Optional) Start Datadog
```bash
docker compose -f datadog.yml up -d
```

## Workers

| Worker | Input Topic | Output Topic | Port |
|--------|------------|--------------|------|
| mail-parser | `lattice.mail.raw.v1` | `lattice.mail.parse.v1` | 3100 |
| mail-chunker | `lattice.mail.parse.v1` | `lattice.mail.chunk.v1` | 3101 |

### Build workers
```bash
docker compose -f lattice-workers.yml build
```

### View logs
```bash
docker compose -f lattice-workers.yml logs -f mail-parser mail-chunker
```

### Health checks
```bash
curl http://localhost:3100/health  # mail-parser
curl http://localhost:3101/health  # mail-chunker
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
