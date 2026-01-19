provider "newrelic" {
  account_id = var.newrelic_account_id
  api_key    = var.newrelic_api_key
  region     = var.newrelic_region
}

locals {
  common_tags = {
    team       = var.team
    managed_by = "terraform"
    project    = "lattice"
  }

  lattice_services = [
    "lattice-worker-mail-parser",
    "lattice-worker-mail-chunker",
    "lattice-worker-mail-embedder",
    "lattice-worker-mail-upserter",
    "lattice-worker-mail-deleter",
    "lattice-worker-audit-writer",
    "lattice-worker-mail-extractor",
    "lattice-worker-attachment-chunker",
    "lattice-worker-mail-ocr-normalizer",
    "lattice-worker-ocr"
  ]

  # NRQL WHERE clause for filtering to Lattice services
  services_filter = join(" OR ", [for s in local.lattice_services : "appName = '${s}'"])
}

# =============================================================================
# Alert Policy - Groups all Lattice worker alerts
# =============================================================================
resource "newrelic_alert_policy" "lattice_workers" {
  name                = "Lattice Worker Alerts"
  incident_preference = "PER_CONDITION_AND_TARGET"
}

# =============================================================================
# Notification Channels
# Note: Slack destinations must be created via New Relic UI, not Terraform.
# To set up Slack: New Relic → Alerts → Destinations → Add destination → Slack
# Then create a workflow in the UI to route alerts to Slack.
# =============================================================================

# PagerDuty notification channel (if configured)
resource "newrelic_notification_destination" "pagerduty" {
  count = var.pagerduty_service_key != "" ? 1 : 0

  name = "Lattice PagerDuty"
  type = "PAGERDUTY_SERVICE_INTEGRATION"

  property {
    key   = "service_key"
    value = var.pagerduty_service_key
  }
}

resource "newrelic_notification_channel" "pagerduty" {
  count = var.pagerduty_service_key != "" ? 1 : 0

  name           = "Lattice PagerDuty Channel"
  type           = "PAGERDUTY_SERVICE_INTEGRATION"
  destination_id = newrelic_notification_destination.pagerduty[0].id
  product        = "IINT"

  property {
    key   = "summary"
    value = "{{issueTitle}}"
  }
}

# =============================================================================
# Workflow to route alerts to PagerDuty (if configured)
# =============================================================================
resource "newrelic_workflow" "lattice_alerts" {
  count                 = var.pagerduty_service_key != "" ? 1 : 0
  name                  = "Lattice Worker Alert Workflow"
  muting_rules_handling = "NOTIFY_ALL_ISSUES"

  issues_filter {
    name = "Lattice Policy Filter"
    type = "FILTER"

    predicate {
      attribute = "labels.policyIds"
      operator  = "EXACTLY_MATCHES"
      values    = [newrelic_alert_policy.lattice_workers.id]
    }
  }

  destination {
    channel_id = newrelic_notification_channel.pagerduty[0].id
  }
}
