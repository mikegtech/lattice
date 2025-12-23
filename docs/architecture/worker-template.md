# Lattice Worker Template

This document defines the standard pattern for NestJS Kafka workers in the Lattice platform.

## Overview

All Kafka workers in Lattice follow a consistent structure using NestJS modules, providing:
- Standardized configuration via environment variables
- Datadog unified service tagging
- Structured JSON logging with PII redaction
- Graceful shutdown with in-flight message handling
- Health endpoints for Kubernetes probes
- Error classification with automatic DLQ routing
- Idempotency support via content hashing

## Folder Structure

```
apps/workers/{worker-name}/
├── src/
│   ├── main.ts                 # NestJS bootstrap
│   ├── app.module.ts           # Root module composition
│   ├── db/                     # Database layer (if needed)
│   │   ├── database.module.ts  # Connection pool module
│   │   └── *.repository.ts     # Repository classes
│   └── worker/
│       ├── worker.module.ts    # Worker module
│       ├── worker.service.ts   # Main processing logic (extends BaseWorkerService)
│       ├── worker.types.ts     # Input/output type definitions
│       └── *.service.ts        # Additional business logic services
├── package.json
├── tsconfig.json
├── .env.example
├── Dockerfile
└── README.md
```

## Environment Variables

### Required - Datadog Unified Service Tagging

| Variable | Description | Example |
|----------|-------------|---------|
| `DD_ENV` | Environment name | `local`, `staging`, `production` |
| `DD_SERVICE` | Service name | `mail-parser` |
| `DD_VERSION` | Service version | `0.1.0` |

### Required - Lattice Custom Tags

| Variable | Description | Example |
|----------|-------------|---------|
| `LATTICE_TEAM` | Owning team | `platform` |
| `LATTICE_CLOUD` | Cloud provider | `aws`, `gcp`, `local` |
| `LATTICE_REGION` | Deployment region | `us-east-1`, `local` |
| `LATTICE_DOMAIN` | Business domain | `mail`, `search`, `auth` |
| `LATTICE_STAGE` | Pipeline stage | `fetch`, `parse`, `embed` |

### Required - Kafka Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `KAFKA_BROKERS` | Comma-separated broker list | `localhost:9092` |
| `KAFKA_CLIENT_ID` | Unique client identifier | `mail-parser-prod-1` |
| `KAFKA_CONSUMER_GROUP` | Consumer group ID | `mail-parser-prod` |
| `KAFKA_INPUT_TOPIC` | Topic to consume from | `lattice.mail.raw.v1` |
| `KAFKA_OUTPUT_TOPIC` | Topic to produce to | `lattice.mail.parse.v1` |
| `KAFKA_DLQ_TOPIC` | Dead letter queue topic | `lattice.mail.raw.v1.dlq` |

### Optional - Kafka Authentication (Confluent Cloud)

| Variable | Description |
|----------|-------------|
| `KAFKA_SASL_USERNAME` | SASL username (API key) |
| `KAFKA_SASL_PASSWORD` | SASL password (API secret) |

### Optional - Worker Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_CONCURRENCY` | `10` | Max concurrent message processing |
| `WORKER_MAX_RETRIES` | `3` | Retries before DLQ |
| `WORKER_COMMIT_INTERVAL_MS` | `5000` | Auto-commit interval |
| `HEALTH_PORT` | `3000` | HTTP port for health endpoints |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `LOG_PRETTY` | `false` | Human-readable logs |

## Module Architecture

### AppModule (app.module.ts)

The root module composes all required modules:

```typescript
import { Module } from '@nestjs/common';
import {
  WorkerConfigModule,
  TelemetryModule,
  KafkaModule,
  HealthModule,
  LifecycleModule,
} from '@lattice/worker-base';
import { DatabaseModule } from './db/database.module.js';
import { WorkerModule } from './worker/worker.module.js';

@Module({
  imports: [
    WorkerConfigModule,    // Configuration with Zod validation
    TelemetryModule,       // Datadog metrics + structured logging
    LifecycleModule,       // Graceful shutdown coordination
    KafkaModule,           // Kafka consumer/producer
    HealthModule,          // /health/live, /health/ready
    DatabaseModule,        // Postgres connection pool
    WorkerModule,          // Your worker logic
  ],
})
export class AppModule {}
```

### WorkerService (worker.service.ts)

Extend `BaseWorkerService` and implement the `process` method:

```typescript
import { Injectable, Inject } from '@nestjs/common';
import {
  BaseWorkerService,
  KafkaService,
  TelemetryService,
  LoggerService,
  LOGGER,
  WORKER_CONFIG,
  type WorkerConfig,
  type WorkerContext,
  classifyError,
} from '@lattice/worker-base';

@Injectable()
export class MyWorkerService extends BaseWorkerService<InputType, OutputType> {
  constructor(
    kafka: KafkaService,
    telemetry: TelemetryService,
    @Inject(LOGGER) logger: LoggerService,
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    // Add your dependencies here
  ) {
    super(kafka, telemetry, logger, config);
  }

  protected async process(
    payload: InputType,
    context: WorkerContext,
  ): Promise<
    | { status: 'success'; output: OutputType }
    | { status: 'skip'; reason: string }
    | { status: 'retry'; reason: string }
    | { status: 'dlq'; reason: string; error: Error }
  > {
    // Your processing logic here

    try {
      const result = await this.processMessage(payload);
      return { status: 'success', output: result };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const classification = classifyError(err);

      if (classification === 'retryable') {
        return { status: 'retry', reason: err.message };
      }

      return { status: 'dlq', reason: err.message, error: err };
    }
  }
}
```

### Process Return Types

| Status | Behavior |
|--------|----------|
| `success` | Publish output to `KAFKA_OUTPUT_TOPIC`, commit offset |
| `skip` | Log skip reason, commit offset (no output published) |
| `retry` | Retry up to `WORKER_MAX_RETRIES`, then DLQ |
| `dlq` | Publish to `KAFKA_DLQ_TOPIC` immediately, commit offset |

## Error Classification

The `classifyError` function categorizes errors:

### Retryable Errors
- Connection failures (`ECONNREFUSED`, `ETIMEDOUT`)
- Kafka broker issues (`LEADER_NOT_AVAILABLE`, `REQUEST_TIMED_OUT`)
- Database connection errors
- Rate limiting (HTTP 429, 503)

### Non-Retryable (DLQ) Errors
- JSON parse errors
- Schema validation failures
- Business logic errors

## Health Endpoints

| Endpoint | Purpose | Success Criteria |
|----------|---------|------------------|
| `GET /health/live` | Kubernetes liveness | Process is running |
| `GET /health/ready` | Kubernetes readiness | Kafka + DB connected |
| `GET /health` | Full status | Detailed component status |

## Graceful Shutdown

The worker handles shutdown signals (SIGTERM, SIGINT):

1. Stop accepting new messages
2. Wait for in-flight messages to complete (30s timeout)
3. Commit final offsets
4. Close Kafka connections
5. Close database pool
6. Exit process

## Logging Standards

### PII Redaction

The logger automatically redacts:
- Email addresses (`user@example.com` → `[EMAIL]`)
- Fields: `password`, `secret`, `token`, `body`, `raw_payload`

### Log Context

Always include structured context:

```typescript
this.logger.info('Processing message', {
  email_id: payload.email_id,
  trace_id: context.traceId,
  stage: 'parse',
});
```

### Datadog Correlation

Logs automatically include trace correlation:
- `dd.trace_id`
- `dd.span_id`
- `dd.service`
- `dd.env`
- `dd.version`

## Telemetry Metrics

Standard metrics emitted by all workers:

| Metric | Type | Tags | Description |
|--------|------|------|-------------|
| `messages.received` | counter | `stage` | Messages consumed |
| `messages.success` | counter | `stage` | Successfully processed |
| `messages.skipped` | counter | `stage`, `reason` | Skipped (duplicate, etc.) |
| `messages.error` | counter | `stage` | Processing errors |
| `messages.dlq` | counter | `stage` | Sent to DLQ |
| `processing_time_ms` | histogram | `stage` | Processing duration |
| `db.query_ms` | histogram | `operation` | Database query time |

## Creating a New Worker

Use the generator script:

```bash
pnpm generate:worker my-worker
```

Or manually:

1. Copy `apps/workers/mail-parser` as a template
2. Update `package.json` name and description
3. Update `.env.example` with correct topics
4. Implement `WorkerService.process()`
5. Add to `pnpm-workspace.yaml` if needed

## Example: mail-parser Worker

The `mail-parser` worker demonstrates the full pattern:

- **Input**: `lattice.mail.raw.v1` (base64-encoded raw email)
- **Output**: `lattice.mail.parse.v1` (parsed headers, body, attachments)
- **Database**: Stores parsed emails in Postgres
- **Idempotency**: Uses content hash to skip duplicates

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│ lattice.mail.   │────▶│ mail-parser  │────▶│ lattice.mail.   │
│ raw.v1          │     │   worker     │     │ parse.v1        │
└─────────────────┘     └──────────────┘     └─────────────────┘
                              │
                              ▼
                        ┌──────────┐
                        │ Postgres │
                        └──────────┘
```

## Dockerfile Template

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json pnpm-*.yaml ./
COPY packages ./packages
COPY apps/workers/my-worker ./apps/workers/my-worker
RUN npm install -g pnpm && pnpm install --frozen-lockfile
RUN pnpm --filter @lattice/my-worker build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/apps/workers/my-worker/dist ./dist
COPY --from=builder /app/apps/workers/my-worker/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/main.js"]
```
