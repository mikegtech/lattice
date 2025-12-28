# Lattice Logging Architecture - Complete Picture

## Overview

Lattice uses a tiered logging architecture that ensures operational visibility in Datadog while controlling costs and noise. The system consists of three layers:

1. **Application Logging** (LoggerService + EventLogger)
2. **Log Processing** (Datadog Log Pipeline)
3. **Observability** (Monitors, Metrics, Dashboard)

---

## What You Should See in Datadog

### On Successful Message Processing

When a worker successfully processes a message, you'll see these events:

```
┌─────────────────────────────────────────────────────────────────┐
│ EVENT: lattice.message.processed                                │
│ ─────────────────────────────────────────────────────────────── │
│ service: lattice-worker-mail-parser                             │
│ stage: parse                                                    │
│ message_id: msg-abc123                                          │
│ email_id: 84536418-f8e8-59f8-bb93-8043eebe75b1                  │
│ duration_ms: 150                                                │
│ tier: operational                                               │
│ dd.forward: true                                                │
│ timestamp: 2025-12-27T15:30:00.000Z                            │
└─────────────────────────────────────────────────────────────────┘
```

### On Worker Startup

```
EVENT: lattice.worker.starting     → Before modules init
EVENT: lattice.kafka.connected     → After Kafka connection established
EVENT: lattice.worker.started      → After fully initialized, includes config
```

Example `lattice.worker.started`:
```json
{
  "event": "lattice.worker.started",
  "dd.forward": true,
  "timestamp": "2025-12-27T15:30:00.000Z",
  "service": "lattice-worker-mail-parser",
  "version": "0.1.0",
  "env": "production",
  "team": "platform",
  "domain": "mail",
  "stage": "parse",
  "config": {
    "kafka_topic_in": "lattice.mail.raw.v1",
    "kafka_topic_out": "lattice.mail.parse.v1",
    "health_port": 3001
  }
}
```

### On Worker Shutdown

```
EVENT: lattice.worker.shutdown.initiated  → Signal received, in_flight_count
EVENT: lattice.worker.shutdown.completed  → Clean shutdown, duration_ms
```

### On Message Skip (Idempotency)

```json
{
  "event": "lattice.message.skipped",
  "dd.forward": true,
  "message_id": "msg-abc123",
  "email_id": "84536418-f8e8-59f8-bb93-8043eebe75b1",
  "stage": "parse",
  "reason": "duplicate"
}
```

### On Message Retry

```json
{
  "event": "lattice.message.retry",
  "dd.forward": true,
  "message_id": "msg-abc123",
  "stage": "embed",
  "attempt": 2,
  "max_attempts": 3,
  "reason": "ETIMEDOUT",
  "backoff_ms": 2000
}
```

### On Failure (DLQ)

```
┌─────────────────────────────────────────────────────────────────┐
│ EVENT: lattice.message.dlq                                      │
│ ─────────────────────────────────────────────────────────────── │
│ service: lattice-worker-mail-embedder                           │
│ stage: embed                                                    │
│ message_id: msg-abc123                                          │
│ email_id: 84536418-f8e8-59f8-bb93-8043eebe75b1                  │
│ error_code: EMBEDDING_SERVICE_UNAVAILABLE                       │
│ error_message: Connection refused to embedding service          │
│ reason: max_retries_exceeded                                    │
│ dlq_topic: lattice.dlq.mail.embed.v1                           │
│ tier: critical                                                  │
│ dd.forward: true                                                │
└─────────────────────────────────────────────────────────────────┘
```

### On Kafka Issues

```json
{
  "event": "lattice.kafka.error",
  "dd.forward": true,
  "broker": "pkc-xxx.us-east-1.aws.confluent.cloud:9092",
  "client_id": "lattice-worker-mail-parser",
  "error_code": "ECONNREFUSED",
  "error_message": "Connection refused"
}
```

---

## Log Tiering System

### Tier Definitions

| Tier | `dd.forward` | When to Use | Level |
|------|--------------|-------------|-------|
| **CRITICAL** | Always `true` | Uncaught exceptions, DLQ events, data corruption | `error` |
| **OPERATIONAL** | Always `true` | Business events, errors, state changes | `info` |
| **LIFECYCLE** | `true` in prod | Startup, shutdown, connection changes | `info` |
| **DEBUG** | `false` (sampled) | Local debugging, verbose tracing | `debug` |

### How Tiering Works

```typescript
// In your worker code:

// CRITICAL - Always shipped, use sparingly
logger.critical('Data corruption detected', { email_id, error_code: 'DATA_CORRUPT' });

// OPERATIONAL - Always shipped, main business events
logger.operational('Email parsed successfully', { email_id, duration_ms: 150 });

// LIFECYCLE - Shipped in production for state changes
logger.lifecycle('Worker starting', { stage: 'parse' });

// DEBUG - Never shipped unless sampled (cost control)
logger.debugTiered('Processing chunk', { chunk_id, chunk_hash });
```

### Configuration

```typescript
// Production config (default)
{
  level: 'info',
  shipTiers: [LogTier.CRITICAL, LogTier.OPERATIONAL, LogTier.LIFECYCLE],
  sampleDebugRate: 0  // No debug logs shipped
}

// Local config
{
  level: 'debug',
  shipTiers: [LogTier.CRITICAL, LogTier.OPERATIONAL, LogTier.LIFECYCLE, LogTier.DEBUG],
  sampleDebugRate: 1  // All debug logs visible locally
}
```

---

## Log Attributes Reference

### Always Present (Base Tags)

| Attribute | Source | Example |
|-----------|--------|---------|
| `env` | `DD_ENV` | `production` |
| `service` | `DD_SERVICE` | `lattice-worker-mail-parser` |
| `version` | `DD_VERSION` | `0.1.0` |
| `team` | `LATTICE_TEAM` | `platform` |
| `cloud` | `LATTICE_CLOUD` | `gcp` |
| `region` | `LATTICE_REGION` | `us-central1` |
| `domain` | `LATTICE_DOMAIN` | `mail` |
| `stage` | `LATTICE_STAGE` | `parse` |

### Tiering Attributes

| Attribute | Description | Values |
|-----------|-------------|--------|
| `tier` | Log importance tier | `critical`, `operational`, `lifecycle`, `debug` |
| `dd.forward` | Should Datadog index this log | `true`, `false` |
| `dd.sampled` | Was this debug log sampled | `true` (only on sampled debug) |

### Event Attributes

| Attribute | Description | Example |
|-----------|-------------|---------|
| `event` | Event name | `lattice.message.processed` |
| `timestamp` | ISO 8601 timestamp | `2025-12-27T15:30:00.000Z` |
| `message_id` | Kafka message ID | `msg-abc123` |
| `email_id` | Lattice email UUID | `84536418-...` |
| `duration_ms` | Operation duration | `150` |
| `error_code` | Error classification | `SCHEMA_VALIDATION` |

### Correlation Attributes (Log ↔ Trace)

| Attribute | Description |
|-----------|-------------|
| `dd.trace_id` | Datadog trace ID |
| `dd.span_id` | Datadog span ID |

---

## Event Naming Convention

All events follow the pattern: `lattice.<domain>.<action>`

### Worker Lifecycle
- `lattice.worker.starting`
- `lattice.worker.started`
- `lattice.worker.shutdown.initiated`
- `lattice.worker.shutdown.completed`

### Message Processing
- `lattice.message.processed`
- `lattice.message.skipped`
- `lattice.message.retry`
- `lattice.message.dlq`

### Kafka Connectivity
- `lattice.kafka.connected`
- `lattice.kafka.disconnected`
- `lattice.kafka.error`
- `lattice.kafka.rebalance`

### Database Events
- `lattice.database.error`
- `lattice.database.slow_query`

### Health Events
- `lattice.health.changed`

---

## Datadog Pipeline Processing

The Terraform-managed pipeline (`infra/datadog/pipelines.tf`) processes logs:

### Pipeline Flow

```
Incoming Log
     │
     ▼
┌────────────────────────────┐
│ Filter: service:lattice-*  │
└────────────────────────────┘
     │
     ▼
┌────────────────────────────┐
│ 1. Remap level → status    │  (Log level colors in Datadog)
└────────────────────────────┘
     │
     ▼
┌────────────────────────────┐
│ 2. Remap event → evt.name  │  (Datadog event tracking)
└────────────────────────────┘
     │
     ▼
┌────────────────────────────┐
│ 3. Categorize by @tier     │  (critical/operational/etc)
└────────────────────────────┘
     │
     ▼
┌────────────────────────────┐
│ 4. Extract error.code      │  (Facet-friendly)
└────────────────────────────┘
     │
     ▼
┌────────────────────────────┐
│ 5. Extract duration        │  (Performance tracking)
└────────────────────────────┘
     │
     ▼
  Indexed Log
```

### Log-Based Metrics Created

| Metric | Type | Description |
|--------|------|-------------|
| `lattice.processing.duration_ms` | Distribution | P50/P95/P99 latencies |
| `lattice.dlq.count` | Count | DLQ messages by error_code |
| `lattice.messages.processed` | Count | Throughput by service/stage |
| `lattice.errors.count` | Count | Errors by service/error_code |

---

## Monitors (Alerts)

### DLQ Monitors
| Monitor | Threshold | Severity |
|---------|-----------|----------|
| DLQ Spike | >10 in 5m | High |
| DLQ Schema Errors | >5 in 15m | High |
| DLQ Critical Volume | >100 in 10m | Critical |

### Error Monitors
| Monitor | Threshold | Severity |
|---------|-----------|----------|
| High Error Rate | >50 in 5m | Medium |
| Sustained Errors | >100 in 30m | Medium |
| Error Spike | >30 in 5m | High |

### Availability Monitors
| Monitor | Condition | Severity |
|---------|-----------|----------|
| No Logs from Worker | No logs for 10m | Critical |
| Worker Shutdown | Shutdown detected | Info |
| Multiple Restarts | >3 in 30m | High |

### Kafka Monitors
| Monitor | Threshold | Severity |
|---------|-----------|----------|
| Connection Errors | >3 in 5m | High |
| Consumer Timeouts | >5 in 5m | High |
| All Workers Disconnected | No connections 15m | Critical |

### Performance Monitors
| Monitor | Threshold | Severity |
|---------|-----------|----------|
| High Processing Latency | Avg >5s | Medium |
| P95 Latency | P95 >5s | Medium |
| Throughput Drop | <10 msgs in 15m | Medium |

---

## Querying Logs in Datadog

### Find All Events for an Email
```
@email_id:84536418-f8e8-59f8-bb93-8043eebe75b1
```

### Find All DLQ Messages
```
@event:lattice.message.dlq
```

### Find Errors by Service
```
level:error service:lattice-worker-mail-embedder
```

### Find Slow Operations
```
@event:lattice.message.processed @duration_ms:>5000
```

### Find by Tier
```
@tier:critical
@tier:operational @dd.forward:true
```

### Find Kafka Issues
```
@event:lattice.kafka.* level:error
```

---

## Local Development vs Production

| Aspect | Local | Production |
|--------|-------|------------|
| Log Format | Pretty (pino-pretty) | JSON |
| Debug Logs | Visible in console | Not shipped to Datadog |
| `dd.forward` | Set but not enforced | Controls indexing |
| Sample Rate | 100% | 0% for debug |

### Verify Local Logging
```bash
# Check JSON output (what Datadog sees)
docker logs lattice-mail-parser 2>&1 | head -5

# Should see single-line JSON like:
# {"level":"info","time":"2025-12-27T15:30:00.000Z","service":"lattice-worker-mail-parser",...}
```

---

## Troubleshooting

### Logs Not Appearing in Datadog

1. **Check `dd.forward` attribute**
   ```
   # In Datadog Logs, search for:
   @dd.forward:false
   ```
   If you see your logs with `dd.forward:false`, they're being filtered.

2. **Check tier configuration**
   - Production should ship: CRITICAL, OPERATIONAL, LIFECYCLE
   - DEBUG tier is NOT shipped by default

3. **Check Datadog Agent**
   ```bash
   curl http://localhost:8125/healthz
   docker logs lattice-datadog-agent
   ```

### High Log Volume / Costs

1. **Review tier usage** - Are DEBUG logs being shipped?
2. **Check sample rate** - Should be 0 in production
3. **Use index filters** - Terraform configures exclusion for `@dd.forward:false`

### Missing Correlation (Logs ↔ Traces)

1. **Check `dd.trace_id` attribute**
2. **Verify APM is enabled** - `DD_APM_ENABLED=true`
3. **Check log injection** - Pino should include trace context
