# =============================================================================
# DLQ (Dead Letter Queue) Monitors
# =============================================================================

resource "datadog_monitor" "dlq_spike" {
  name    = "[Lattice] DLQ Spike Detected"
  type    = "log alert"

  query = "logs(\"@event:lattice.message.dlq service:(${local.services_query})\").index(\"*\").rollup(\"count\").by(\"service\").last(\"5m\") > 10"

  message = <<-EOT
## DLQ Spike Detected

**Service**: {{service.name}}
**Environment**: {{env.name}}
**Count**: {{value}} messages sent to DLQ in last 5 minutes

### Quick Links
- [DLQ Logs](https://app.datadoghq.com/logs?query=%40event%3Alattice.message.dlq%20service%3A{{service.name}})
- [Service Dashboard](https://app.datadoghq.com/dashboard/xxx-xxx-xxx?tpl_var_service={{service.name}})

### Investigation Steps
1. Check error_code distribution in DLQ logs
2. Identify if single message type or widespread failure
3. Check upstream service health
4. Review recent deployments

### Context for AI Engineer
The Dead Letter Queue (DLQ) receives messages that failed processing after all retries.

**Common causes:**
- Schema validation failures (poison messages from producer)
- Downstream service unavailable (database, Milvus, external API)
- Rate limiting from external services
- Message payload exceeds size limits

**Suggested actions based on error_code:**
- `SCHEMA_VALIDATION`: Check producer for malformed messages
- `ETIMEDOUT`/`ECONNREFUSED`: Check dependent service health
- `RATE_LIMITED`: Review backoff configuration

### Runbook
[DLQ Investigation Runbook](https://your-docs-url/runbooks/dlq-spike)

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
{{#is_warning}}
${local.notify_slack_alerts}
{{/is_warning}}
EOT

  monitor_thresholds {
    critical = 10
    warning  = 5
  }

  notify_no_data    = false
  renotify_interval = 30

  tags = concat(local.common_tags, [
    "severity:high",
    "category:data-quality"
  ])
}

resource "datadog_monitor" "dlq_schema_errors" {
  name = "[Lattice] DLQ - Schema Validation Failures"
  type = "log alert"

  query = "logs(\"@event:lattice.message.dlq @error_code:SCHEMA_VALIDATION service:(${local.services_query})\").index(\"*\").rollup(\"count\").last(\"15m\") > 5"

  message = <<-EOT
## Schema Validation Failures in DLQ

{{value}} messages failed schema validation in the last 15 minutes.

This indicates a producer is sending malformed messages.

### Investigation Steps
1. Check recent producer deployments
2. Verify schema version compatibility
3. Review upstream data source changes
4. Check message samples in DLQ logs

### Quick Links
- [Schema Error Logs](https://app.datadoghq.com/logs?query=%40event%3Alattice.message.dlq%20%40error_code%3ASCHEMA_VALIDATION)

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 5
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = concat(local.common_tags, [
    "severity:high",
    "category:data-quality",
    "error_type:schema"
  ])
}

resource "datadog_monitor" "dlq_critical_volume" {
  name = "[Lattice] DLQ Critical Volume - Immediate Attention Required"
  type = "log alert"

  query = "logs(\"@event:lattice.message.dlq service:(${local.services_query})\").index(\"*\").rollup(\"count\").last(\"10m\") > 100"

  message = <<-EOT
## CRITICAL: High DLQ Volume

**{{value}} messages** sent to DLQ in the last 10 minutes.

This is a critical threshold indicating a major processing failure.

### Immediate Actions Required
1. Check all worker services for common error patterns
2. Verify Kafka connectivity
3. Check database availability
4. Review recent deployments across all services

### Escalation
This alert indicates potential data loss. Escalate to on-call immediately.

{{#is_alert}}
${local.notify_critical}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 100
  }

  notify_no_data    = false
  renotify_interval = 15

  tags = concat(local.common_tags, [
    "severity:critical",
    "category:data-quality",
    "escalation:immediate"
  ])
}
