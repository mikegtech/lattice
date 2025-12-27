# =============================================================================
# Kafka Connectivity Monitors
# =============================================================================

resource "datadog_monitor" "kafka_connection_error" {
  name = "[Lattice] Kafka Connection Errors"
  type = "log alert"

  query = "logs(\"@event:lattice.kafka.error service:(${local.services_query})\").index(\"*\").rollup(\"count\").by(\"service\").last(\"5m\") > 3"

  message = <<-EOT
## Kafka Connection Errors

**Service**: {{service.name}}
**Error Count**: {{value}} in last 5 minutes

### Common Causes
1. Confluent Cloud broker unreachable
2. Authentication/authorization failure (SASL credentials)
3. Network policy blocking traffic
4. Broker maintenance window
5. Consumer group rebalancing

### Investigation Steps
1. Check Confluent Cloud status: https://status.confluent.cloud
2. Verify KAFKA_SASL credentials are current
3. Check network policies in Kubernetes
4. Review Kafka consumer group status in Confluent Cloud UI
5. Check for broker leader elections

### Quick Links
- [Kafka Connection Logs](https://app.datadoghq.com/logs?query=%40event%3Alattice.kafka.*%20service%3A{{service.name}})
- [Confluent Cloud Console](https://confluent.cloud)

### Context for AI Engineer
Kafka connection errors can cascade:
- One broker issue affects multiple workers
- Rebalancing can cause temporary errors
- Check if all workers are affected or just one

If only one worker is affected, likely pod-specific issue.
If all workers affected, likely Kafka cluster issue.

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 3
  }

  notify_no_data    = false
  renotify_interval = 30

  tags = concat(local.common_tags, [
    "severity:high",
    "category:connectivity",
    "component:kafka"
  ])
}

resource "datadog_monitor" "kafka_consumer_timeout" {
  name = "[Lattice] Kafka Consumer Timeouts"
  type = "log alert"

  query = "logs(\"service:(${local.services_query}) (ETIMEDOUT OR *timeout* OR *ECONNREFUSED*)\").index(\"*\").rollup(\"count\").by(\"service\").last(\"5m\") > 5"

  message = <<-EOT
## Kafka Consumer Timeouts Detected

**Service**: {{service.name}}
**Timeout Count**: {{value}} in last 5 minutes

### Possible Causes
1. Network latency to Confluent Cloud
2. Broker overloaded
3. Consumer processing too slow (session timeout)
4. DNS resolution issues

### Investigation Steps
1. Check network latency from worker pods
2. Verify Confluent Cloud cluster health
3. Review consumer group lag
4. Check if session.timeout.ms is appropriate

### Context for AI Engineer
Timeouts during Kafka operations indicate network or broker issues.

If timeouts are sporadic: likely transient network issue
If timeouts are consistent: check broker health and network path

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 5
  }

  notify_no_data    = false
  renotify_interval = 30

  tags = concat(local.common_tags, [
    "severity:high",
    "category:connectivity",
    "component:kafka"
  ])
}

resource "datadog_monitor" "kafka_all_workers_disconnected" {
  name = "[Lattice] CRITICAL - All Kafka Workers Disconnected"
  type = "log alert"

  query = "logs(\"@event:lattice.kafka.connected service:(${local.services_query})\").index(\"*\").rollup(\"count\").last(\"15m\") < 1"

  message = <<-EOT
## CRITICAL: No Kafka Connections

No Kafka connection events from any Lattice worker in the last 15 minutes.

This indicates a complete Kafka connectivity failure or all workers are down.

### Immediate Actions
1. Check Confluent Cloud status immediately
2. Verify all worker pods are running
3. Check Kubernetes cluster networking
4. Review recent infrastructure changes

### Escalation
This is a critical incident - data pipeline is completely stopped.

{{#is_alert}}
${local.notify_critical}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 1
  }

  notify_no_data    = true
  no_data_timeframe = 20

  tags = concat(local.common_tags, [
    "severity:critical",
    "category:connectivity",
    "component:kafka",
    "escalation:immediate"
  ])
}
