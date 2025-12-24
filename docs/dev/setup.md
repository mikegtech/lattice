# Development Setup

## Prerequisites

- Node.js 20+
- pnpm 8+
- Python 3.11+
- uv (Python package manager)
- Docker & Docker Compose

## Installation

```bash
# Clone the repository
git clone <repo>
cd lattice

# Install Node.js dependencies
pnpm install

# Install Python dependencies
uv sync --extra dev

# Build all packages
pnpm build
```

## Pre-commit Hooks

This repository uses `pre-commit` for local guardrails.

```bash
uv pip install pre-commit
pre-commit install
```

## Environment Configuration

```bash
# Copy example environment files
cp infra/local/compose/.env.example infra/local/compose/.env
cp apps/workers/mail-parser/.env.example apps/workers/mail-parser/.env

# Edit with your credentials (Confluent Cloud, Datadog, etc.)
```

## Local Infrastructure

```bash
# Start Postgres, Milvus, Airflow
pnpm docker:up

# Stop infrastructure
pnpm docker:down
```

## Running Workers

```bash
# Development mode (with hot reload)
cd apps/workers/mail-parser
pnpm dev

# Production mode
pnpm start
```
