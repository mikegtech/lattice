# =============================================================================
# Error Rate Monitors
# =============================================================================

resource "datadog_monitor" "error_rate" {
  name = "[Lattice] High Error Rate - {{service.name}}"
  type = "log alert"

  query = "logs(\"level:error service:(${local.services_query})\").index(\"*\").rollup(\"count\").by(\"service\").last(\"5m\") > 50"

  message = <<-EOT
## High Error Rate Detected

**Service**: {{service.name}}
**Error Count**: {{value}} errors in last 5 minutes

### Quick Links
- [Error Logs](https://app.datadoghq.com/logs?query=level%3Aerror%20service%3A{{service.name}})
- [APM Service](https://app.datadoghq.com/apm/service/{{service.name}})

### Investigation Steps
1. Check error log patterns - is it one error type or many?
2. Correlate with recent deployments
3. Check dependent service health (Kafka, Postgres, Milvus)
4. Review resource utilization (CPU, memory)

### Context for AI Engineer
High error rates can indicate:
- Transient infrastructure issues (usually recovers)
- Bug in recent deployment (check recent commits)
- Downstream dependency failure
- Resource exhaustion

Check the error_code distribution to identify the root cause pattern.

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
{{#is_warning}}
${local.notify_slack_alerts}
{{/is_warning}}
EOT

  monitor_thresholds {
    critical = 50
    warning  = 20
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = concat(local.common_tags, [
    "severity:medium",
    "category:reliability"
  ])
}

resource "datadog_monitor" "sustained_errors" {
  name = "[Lattice] Sustained Errors - {{service.name}}"
  type = "log alert"

  query = "logs(\"level:error service:(${local.services_query})\").index(\"*\").rollup(\"count\").by(\"service\").last(\"30m\") > 100"

  message = <<-EOT
## Sustained Error Pattern Detected

**Service**: {{service.name}}
**Error Count**: {{value}} errors over last 30 minutes

This indicates an ongoing issue, not a transient spike.

### Investigation Steps
1. This is not a temporary issue - investigate root cause
2. Check if errors started after a specific deployment
3. Review infrastructure health over the same period
4. Check for memory leaks or connection pool exhaustion

### Context for AI Engineer
Sustained errors over 30 minutes typically indicate:
- Configuration issue
- Memory leak causing degradation over time
- Persistent downstream failure
- Data corruption in source systems

This requires investigation even if the rate is low.

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 100
  }

  notify_no_data    = false
  renotify_interval = 120

  tags = concat(local.common_tags, [
    "severity:medium",
    "category:reliability"
  ])
}

resource "datadog_monitor" "error_spike" {
  name = "[Lattice] Error Spike - Sudden Increase"
  type = "log alert"

  # Detect sudden spike by comparing last 5 min to previous 30 min average
  query = "logs(\"level:error service:(${local.services_query})\").index(\"*\").rollup(\"count\").last(\"5m\") > 30"

  message = <<-EOT
## Sudden Error Spike Detected

**Error Count**: {{value}} errors in last 5 minutes

This represents a sudden increase in errors across Lattice workers.

### Immediate Actions
1. Check for recent deployments (last 30 minutes)
2. Verify Kafka broker connectivity
3. Check database connection pool status
4. Review Kubernetes pod status

### Quick Links
- [All Error Logs](https://app.datadoghq.com/logs?query=level%3Aerror%20service%3Alattice-worker-*)
- [Deployments](https://app.datadoghq.com/ci/deployments)

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 30
  }

  notify_no_data    = false
  renotify_interval = 30

  tags = concat(local.common_tags, [
    "severity:high",
    "category:reliability"
  ])
}
