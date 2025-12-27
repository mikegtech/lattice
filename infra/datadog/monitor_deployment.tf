# =============================================================================
# CI/CD Deployment Monitors
# =============================================================================
# These monitors watch for deployment events sent from GitHub Actions
# All CI/CD notifications flow through Datadog instead of direct Slack webhooks

resource "datadog_monitor" "deployment_failed" {
  name = "[Lattice] Infrastructure Deployment Failed"
  type = "event-v2 alert"

  query = "events(\"source:github status:failed service:terraform\").rollup(\"count\").last(\"5m\") > 0"

  message = <<-EOT
## Infrastructure Deployment Failed

A Terraform deployment to Datadog infrastructure has failed.

### Immediate Actions
1. Check the GitHub Actions run for details
2. Review Terraform plan output
3. Fix the issue and re-run or revert

### Context
This alert is triggered by deployment events sent from GitHub Actions.
Check the event details for the specific commit and author.

{{#is_alert}}
${local.notify_slack_alerts}
{{/is_alert}}
EOT

  monitor_thresholds {
    critical = 0
  }

  notify_no_data    = false
  renotify_interval = 0

  tags = concat(local.common_tags, [
    "severity:high",
    "category:deployment",
    "source:github-actions"
  ])
}

resource "datadog_monitor" "deployment_success" {
  name = "[Lattice] Infrastructure Deployment Succeeded"
  type = "event-v2 alert"

  query = "events(\"source:github status:success service:terraform\").rollup(\"count\").last(\"5m\") > 0"

  message = <<-EOT
## Infrastructure Deployment Succeeded ✅

Terraform deployment to Datadog infrastructure completed successfully.

Check the GitHub Actions run for details about what changed.

${local.notify_slack_alerts}
EOT

  monitor_thresholds {
    critical = 0
  }

  notify_no_data    = false
  renotify_interval = 0

  # This is informational - set priority to low
  priority = 5

  tags = concat(local.common_tags, [
    "severity:info",
    "category:deployment",
    "source:github-actions"
  ])
}
