# ADR-002: Logging Tag Explosion Diagnosis

**Status:** Diagnosis Complete
**Date:** 2025-12-26
**Authors:** Claude Code

## Context

Datadog shows excessive log chatter from Lattice workers. Instead of structured JSON logs with tags as attributes, each tag (team, version, service, env, stage, domain, region, cloud) appears as a separate log line.

Example of what Datadog sees:
- Log entry 1: `[timestamp] INFO: Processing raw email`
- Log entry 2: `env: "local"`
- Log entry 3: `service: "lattice-worker-mail-parser"`
- Log entry 4: `version: "0.1.0"`
- ... (8-10 entries per actual log call)

## Investigation

### Files Examined

1. `packages/worker-base/src/telemetry/logger.service.ts`
2. `packages/worker-base/src/config/config.module.ts`
3. `packages/worker-base/src/telemetry/telemetry.module.ts`
4. `apps/workers/mail-parser/src/main.ts`

### Root Cause

The issue is in `logger.service.ts` lines 95-118:

```typescript
const isPretty = config.env === "dev" || config.env === "local";

if (isPretty) {
    options.transport = {
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
        },
    };
}
```

When `DD_ENV=local` (which is set in the docker-compose for local development):
1. `config.env` evaluates to `"local"`
2. `isPretty` becomes `true`
3. Pino uses the `pino-pretty` transport
4. Pino-pretty outputs logs in a multi-line YAML-like format:

```
[2025-12-26 23:03:22.508 +0000] INFO: Processing raw email
    env: "local"
    service: "lattice-worker-mail-parser"
    version: "0.1.0"
    team: "platform"
    cloud: "local"
    region: "local"
    domain: "mail"
    stage: "parse"
    provider_message_id: "18d5bc9109c6b939"
    email_id: "84536418-f8e8-59f8-bb93-8043eebe75b1"
    dd: {}
```

### Why Datadog Misparses

The Datadog agent's default log parsing:
1. Reads stdout/stderr line by line
2. Each line starting with a timestamp or level indicator is treated as a new log entry
3. Indented continuation lines (like `    env: "local"`) are NOT recognized as belonging to the previous entry
4. Result: Each attribute line becomes a separate log entry

### Code Flow

```
main.ts bootstrap()
    ↓
NestFactory.create(AppModule, { bufferLogs: true })
    ↓
TelemetryModule provides LOGGER
    ↓
LoggerService constructor(config)
    ↓
isPretty = config.env === "local"  // TRUE
    ↓
pino({ transport: { target: "pino-pretty" }})
    ↓
Multi-line output to stdout
    ↓
Datadog agent reads each line as separate entry
```

## Recommended Fixes

### Option A: Add LOG_FORMAT Environment Variable (Recommended)

Add a new environment variable to explicitly control output format:

```typescript
// In config.module.ts
LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),

// In logger.service.ts
const isPretty = config.logFormat === "pretty" ||
    (config.logFormat === undefined &&
     config.env === "local" &&
     !process.env.DD_AGENT_HOST);
```

Benefits:
- Explicit control over log format
- Auto-detect: use JSON when DD_AGENT_HOST is set
- Backwards compatible with current behavior

### Option B: Configure pino-pretty for Single-Line Output

```typescript
options.transport = {
    target: "pino-pretty",
    options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
        singleLine: true,  // <-- Add this
    },
};
```

Benefits:
- Simple change
- Still human-readable in terminal

Drawbacks:
- Very long lines with many attributes
- Less readable for debugging

### Option C: Configure Datadog Agent Multiline Parsing

Add to Datadog agent configuration:

```yaml
logs:
  - type: docker
    source: nodejs
    service: lattice-workers
    log_processing_rules:
      - type: multi_line
        name: pino_pretty_multiline
        pattern: '^\[\d{4}-\d{2}-\d{2}'
```

Benefits:
- No code changes needed

Drawbacks:
- Complex regex patterns
- Requires agent config management
- May not work reliably with all log formats

## Decision

**Pending** - This ADR documents the diagnosis. Implementation decision to be made by the team.

## Verification

Run the diagnostic script:
```bash
npx tsx tools/scripts/diagnose-logging.ts
```

View actual worker output:
```bash
docker logs lattice-mail-parser 2>&1 | head -30
```

## References

- [Pino Pretty Documentation](https://github.com/pinojs/pino-pretty)
- [Datadog Log Collection](https://docs.datadoghq.com/logs/log_collection/)
- [Datadog Multiline Logs](https://docs.datadoghq.com/agent/logs/advanced_log_collection/#multi-line-aggregation)
