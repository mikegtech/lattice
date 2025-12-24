# Local Docker Compose Layout

This directory contains **purpose-scoped Docker Compose files**.
There is intentionally no root-level docker-compose.yml.

## Files

- datadog.yml
  - Datadog Agent (logs, metrics, traces)

- lattice-core.yml
  - Postgres
  - Milvus (and dependencies)
  - Optional: MinIO

- airflow.yml
  - Airflow webserver, scheduler, worker

- lattice-workers.yml
  - Kafka workers (mail-parser, mail-chunker, etc.)

## Startup Order

1. datadog.yml
2. lattice-core.yml
3. airflow.yml
4. lattice-workers.yml

Each compose file is independently runnable.
