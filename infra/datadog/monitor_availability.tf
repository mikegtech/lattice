# =============================================================================
# Availability Monitors
# =============================================================================

resource "datadog_monitor" "worker_no_logs" {
  name = "[Lattice] No Logs from Worker - {{service.name}}"
  type = "log alert"

  query = "logs(\"service:(${local.services_query})\").index(\"*\").rollup(\"count\").by(\"service\").last(\"10m\") < 1"

  message = <<-EOT
## No Logs Received from Worker

**Service**: {{service.name}}
**Duration**: No logs in last 10 minutes

### Possible Causes
1. Worker crashed or was terminated
2. Kubernetes pod not running
3. Log shipping issue (dd-agent down)
4. Network connectivity issue
5. Worker idle (no messages to process)

### Immediate Actions
1. Check Kubernetes pod status:
   ```
   kubectl get pods -l app={{service.name}} -n lattice
   ```
2. Check pod logs:
   ```
   kubectl logs -l app={{service.name}} -n lattice --tail=100
   ```
3. Verify dd-agent is running in the cluster
4. Check for OOM kills:
   ```
   kubectl get events -n lattice --sort-by='.lastTimestamp'
   ```

### Context for AI Engineer
Complete log silence usually indicates:
- Pod crash (check for OOMKilled or Error status)
- Node failure (check node status)
- Network partition (check connectivity)
- Agent failure (verify dd-agent daemonset)

If the worker is intentionally stopped, this alert can be silenced.

{{#is_alert}}
${local.notify_critical}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 1
  }

  notify_no_data    = true
  no_data_timeframe = 15

  tags = concat(local.common_tags, [
    "severity:critical",
    "category:availability"
  ])
}

resource "datadog_monitor" "worker_shutdown_detected" {
  name = "[Lattice] Worker Shutdown Detected"
  type = "log alert"

  query = "logs(\"@event:lattice.worker.shutdown service:(${local.services_query})\").index(\"*\").rollup(\"count\").by(\"service\").last(\"5m\") > 0"

  message = <<-EOT
## Worker Shutdown Detected

**Service**: {{service.name}}
**Event**: Worker shutdown event received

This is informational - a worker has shut down. This could be:
- Normal deployment/rollout
- Scale-down event
- Pod eviction
- Manual restart

### Verification
1. Check if this was an expected deployment
2. Verify a new pod is starting
3. Monitor for successful startup event

### Quick Links
- [Lifecycle Events](https://app.datadoghq.com/logs?query=%40event%3Alattice.worker.*%20service%3A{{service.name}})

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 0
  }

  notify_no_data    = false
  renotify_interval = 0  # Don't renotify - this is informational

  tags = concat(local.common_tags, [
    "severity:info",
    "category:availability"
  ])
}

resource "datadog_monitor" "worker_multiple_restarts" {
  name = "[Lattice] Multiple Worker Restarts - {{service.name}}"
  type = "log alert"

  query = "logs(\"@event:lattice.worker.started service:(${local.services_query})\").index(\"*\").rollup(\"count\").by(\"service\").last(\"30m\") > 3"

  message = <<-EOT
## Multiple Worker Restarts Detected

**Service**: {{service.name}}
**Restart Count**: {{value}} restarts in last 30 minutes

Multiple restarts may indicate:
- CrashLoopBackOff condition
- OOM kills
- Liveness probe failures
- Configuration issues

### Investigation Steps
1. Check pod status and restart count:
   ```
   kubectl get pods -l app={{service.name}} -n lattice
   kubectl describe pod -l app={{service.name}} -n lattice
   ```
2. Check for OOM events:
   ```
   kubectl get events -n lattice | grep OOM
   ```
3. Review pod logs for crash reasons
4. Check resource limits vs actual usage

### Context for AI Engineer
Restart loops typically indicate:
- Memory limit too low (OOMKilled)
- Startup timeout too short
- Missing configuration/secrets
- Database connection failure on startup

Check the events just before each restart to identify the pattern.

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 3
  }

  notify_no_data    = false
  renotify_interval = 60

  tags = concat(local.common_tags, [
    "severity:high",
    "category:availability"
  ])
}
