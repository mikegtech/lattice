# =============================================================================
# Performance / Latency Monitors
# =============================================================================

resource "datadog_monitor" "processing_latency_p95" {
  name = "[Lattice] High Processing Latency - {{service.name}}"
  type = "log alert"

  query = "logs(\"@event:lattice.message.processed @duration_ms:* service:(${local.services_query})\").index(\"*\").rollup(\"avg\", \"@duration_ms\").by(\"service\").last(\"5m\") > 5000"

  message = <<-EOT
## High Processing Latency

**Service**: {{service.name}}
**Average Latency**: {{value}}ms over last 5 minutes

### Possible Causes
1. Slow database queries
2. External API latency (embedding service, etc.)
3. Large message payloads
4. Resource contention (CPU/memory)
5. Garbage collection pauses

### Investigation Steps
1. Check APM traces for slow spans
2. Review database query performance
3. Check pod resource utilization:
   ```
   kubectl top pods -l app={{service.name}} -n lattice
   ```
4. Look for GC pauses in logs

### Quick Links
- [Service Traces](https://app.datadoghq.com/apm/traces?query=service%3A{{service.name}})
- [Processing Duration Logs](https://app.datadoghq.com/logs?query=%40event%3Alattice.message.processed%20service%3A{{service.name}})

### Context for AI Engineer
Normal processing times by stage:
- parse: 50-200ms
- chunk: 100-500ms
- embed: 500-2000ms (depends on embedding service)
- upsert: 100-500ms

If latency exceeds these baselines, investigate that stage specifically.

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
{{#is_warning}}
${local.notify_slack_alerts}
{{/is_warning}}
EOT

  monitor_thresholds {
    critical = 5000   # 5 seconds
    warning  = 2000   # 2 seconds
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = concat(local.common_tags, [
    "severity:medium",
    "category:performance"
  ])
}

resource "datadog_monitor" "processing_latency_metric" {
  name = "[Lattice] Processing Latency P95 (Metric)"
  type = "metric alert"

  # Uses the log-based metric created in pipelines.tf
  query = "avg(last_5m):p95:lattice.processing.duration_ms{*} by {service} > 5000"

  message = <<-EOT
## High P95 Processing Latency

**Service**: {{service.name}}
**P95 Latency**: {{value}}ms

This monitor uses a log-based metric for accurate percentile calculation.

### Investigation
The 95th percentile being high means 5% of messages are processing slowly.

1. Look for outlier messages (large payloads, complex content)
2. Check for periodic slow operations
3. Review resource utilization during slow periods

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 5000
    warning  = 3000
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = concat(local.common_tags, [
    "severity:medium",
    "category:performance"
  ])

  depends_on = [datadog_logs_metric.processing_duration]
}

resource "datadog_monitor" "throughput_drop" {
  name = "[Lattice] Throughput Drop Detected"
  type = "log alert"

  query = "logs(\"@event:lattice.message.processed service:(${local.services_query})\").index(\"*\").rollup(\"count\").last(\"15m\") < 10"

  message = <<-EOT
## Low Throughput Detected

**Messages Processed**: {{value}} in last 15 minutes

This is significantly below expected throughput.

### Possible Causes
1. No incoming messages (check Kafka topic)
2. Worker stuck or deadlocked
3. Consumer lag building up
4. Processing errors causing slowdown

### Investigation Steps
1. Check Kafka consumer lag in Confluent Cloud
2. Verify messages are being produced to input topics
3. Check for any stuck/pending operations
4. Review worker logs for blocked operations

### Note
This could be normal during low-traffic periods. Check if this is expected based on time of day.

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 10
  }

  notify_no_data    = true
  no_data_timeframe = 20

  tags = concat(local.common_tags, [
    "severity:medium",
    "category:performance"
  ])
}
