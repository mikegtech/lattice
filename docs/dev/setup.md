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

## Secrets Detection

We use `detect-secrets` as part of our pre-commit hooks to prevent accidental commits of API keys, passwords, tokens, and other sensitive data. This is a critical security guardrail that runs automatically on every commit.

### How it works

1. **Baseline file** (`.secrets.baseline`): Contains a snapshot of "known" secrets or false positives in the codebase. This allows the tool to distinguish between:
   - New secrets (blocks commit)
   - Previously reviewed false positives (allows commit)

2. **Pre-commit hook**: Scans staged files for high-entropy strings, known secret patterns (AWS keys, GitHub tokens, etc.), and keyword matches.

### Initial setup

The baseline was created by scanning the entire codebase:
```bash
detect-secrets scan > .secrets.baseline
```

### Managing false positives

If `detect-secrets` flags a non-secret (e.g., a hash constant or test fixture):
```bash
# Audit the baseline interactively
detect-secrets audit .secrets.baseline

# Or regenerate after marking false positives
detect-secrets scan --baseline .secrets.baseline > .secrets.baseline.new
mv .secrets.baseline.new .secrets.baseline
```

### Why at project setup?

Establishing the secrets baseline early ensures:
- All future commits are scanned before secrets can leak
- The team has a clean starting point with reviewed false positives
- CI/CD can enforce the same checks as local development

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
