# Telemetry Tags

Standard tags applied across all Lattice services for Datadog observability.
All services MUST emit these tags consistently for unified service tagging.

## Required Tags (Datadog Unified Service Tagging)

These tags MUST be present on all metrics, logs, and traces:

| Tag | Description | Example | Source |
|-----|-------------|---------|--------|
| `env` | Deployment environment | `dev`, `staging`, `prod` | `ENV` env var |
| `service` | Service name | `mail-parser`, `mail-embedder` | `SERVICE_NAME` env var |
| `version` | Service version (semver) | `0.1.0`, `1.2.3` | `SERVICE_VERSION` env var |

## Optional Context Tags

These tags provide additional context and SHOULD be included where applicable:

| Tag | Description | Example | Cardinality |
|-----|-------------|---------|-------------|
| `team` | Owning team | `platform`, `data` | Low |
| `cloud` | Cloud provider | `gcp`, `aws` | Low |
| `region` | Cloud region | `us-central1`, `us-east-1` | Low |
| `domain` | Business domain | `mail`, `calendar` | Low |
| `pipeline` | Pipeline name | `mail-indexing` | Low |
| `stage` | Pipeline stage | `raw`, `parse`, `chunk`, `embed`, `upsert` | Low |

## High-Cardinality Tags (Logs/Traces Only)

These tags MUST NOT be used on metrics to prevent cardinality explosion.
They are acceptable in logs and trace span attributes only.

| Tag | Description | Use Case |
|-----|-------------|----------|
| `account_id` | Gmail account identifier | Debugging, filtering |
| `tenant_id` | Tenant identifier | Multi-tenant debugging |
| `email_id` | Lattice email UUID | Tracing specific emails |
| `provider_message_id` | Gmail message ID | Cross-referencing with Gmail |
| `chunk_id` | Chunk UUID | Tracing specific chunks |
| `trace_id` | Distributed trace ID | Log-trace correlation |
| `span_id` | Span ID | Log-trace correlation |
| `message_id` | Kafka message ID | Message tracing |

## Approved Metric Dimensions

In addition to the required and optional tags, these low-cardinality dimensions are
allowed on metrics for categorization:

| Tag | Description | Example |
|-----|-------------|---------|
| `error_code` | Error classification code | `E001`, `TIMEOUT` |
| `reason` | Skip/failure reason | `duplicate`, `invalid` |
| `status` | Operation status | `success`, `failed` |
| `operation` | Operation type | `insert`, `update` |
| `topic` | Kafka topic name | `lattice.mail.raw.v1` |

## Cardinality Rules

1. **Metrics**: Only use low-cardinality tags (required + optional + approved dimensions)
2. **Logs**: Can include high-cardinality tags for debugging
3. **Traces**: Can include high-cardinality tags as span attributes

### Why This Matters

High-cardinality tags on metrics cause:
- Metric explosion (billing impact)
- Query performance degradation
- Dashboard timeout issues

## Standard Metrics

### Worker Metrics

All workers MUST emit these metrics:

| Metric | Type | Description | Tags |
|--------|------|-------------|------|
| `lattice.<worker>.messages.received` | Counter | Messages consumed | `stage` |
| `lattice.<worker>.messages.success` | Counter | Successfully processed | `stage` |
| `lattice.<worker>.messages.error` | Counter | Processing errors | `stage`, `error_code` |
| `lattice.<worker>.messages.skipped` | Counter | Skipped (duplicate) | `stage`, `reason` |
| `lattice.<worker>.messages.processed.duration_ms` | Histogram | Processing time | `stage` |
| `lattice.<worker>.db.upsert.duration_ms` | Histogram | DB operation time | `stage` |

### Pipeline Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `lattice.pipeline.indexing_lag_ms` | Gauge | Time from Gmail receipt to full indexing |
| `lattice.pipeline.backlog_size` | Gauge | Number of pending messages |

## Log Format

All logs MUST be JSON formatted with these fields:

```json
{
  "@timestamp": "2024-01-15T10:30:00.000Z",
  "level": "INFO",
  "message": "Email parsed successfully",
  "env": "dev",
  "service": "mail-parser",
  "version": "0.1.0",
  "dd": {
    "trace_id": "1234567890",
    "span_id": "9876543210"
  },
  "email_id": "uuid-here",
  "stage": "parse",
  "duration_ms": 150
}
```

## Trace Span Naming

Span names follow the pattern: `<service>.<operation>`

Examples:
- `mail-parser.process_message`
- `mail-parser.db.upsert_email`
- `mail-parser.kafka.produce`

## Implementation

Use `@lattice/core-telemetry` for TypeScript services:

```typescript
import { createTagBuilder, createLogger, createMetrics } from '@lattice/core-telemetry';

const tagBuilder = createTagBuilder(config.service);

// For metrics (no high-cardinality)
metrics.increment('messages.success', 1, tagBuilder.forMetric({ stage: 'parse' }));

// For logs (can include high-cardinality)
logger.info('Email processed', tagBuilder.forLog({
  email_id: envelope.payload.email_id,
  stage: 'parse',
}));

// For trace span attributes (can include high-cardinality)
const spanTags = tagBuilder.forTrace({
  email_id: envelope.payload.email_id,
  account_id: envelope.account_id,
});
```

## Enforcement

Telemetry compliance is enforced at multiple levels:

### Runtime Enforcement

The `tagBuilder.forMetric()` function **throws** a `HighCardinalityMetricError` if
any forbidden high-cardinality tags are passed. This catches violations during
development and testing.

```typescript
// This will throw HighCardinalityMetricError at runtime
tagBuilder.forMetric({ email_id: 'uuid' }); // ❌ Throws!

// Use forLog() or forTrace() for high-cardinality data
tagBuilder.forLog({ email_id: 'uuid' }); // ✅ OK
```

### CI Enforcement

Two validation scripts run in CI (policy.yml):

1. **`pnpm run telemetry:lint`** - Scans TypeScript code for forbidden metric tags
2. **`pnpm run compose:validate`** - Validates worker compose files have required env vars

### Required Environment Variables

All workers must define these env vars in their compose configuration:

```yaml
environment:
  # Datadog unified service tagging
  DD_ENV: local
  DD_SERVICE: my-worker
  DD_VERSION: "0.1.0"
  # Lattice context
  LATTICE_TEAM: platform
  LATTICE_CLOUD: local
  LATTICE_REGION: local
  LATTICE_DOMAIN: mail
  LATTICE_STAGE: parse
```
