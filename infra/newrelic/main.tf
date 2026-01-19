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
# Notification Channels - Native Slack Integration
# =============================================================================

# Native Slack destination (requires Slack to be connected in New Relic UI first)
# To set up: New Relic → Alerts → Destinations → Add destination → Slack
resource "newrelic_notification_destination" "slack" {
  count = var.slack_channel_id != "" ? 1 : 0

  name = "Lattice Slack Alerts"
  type = "SLACK"

  auth_token {
    prefix = "Bearer"
    token  = var.slack_oauth_token
  }

  property {
    key   = "teamId"
    value = var.slack_team_id
  }
}

resource "newrelic_notification_channel" "slack" {
  count = var.slack_channel_id != "" ? 1 : 0

  name           = "Lattice Slack Channel"
  type           = "SLACK"
  destination_id = newrelic_notification_destination.slack[0].id
  product        = "IINT"

  property {
    key   = "channelId"
    value = var.slack_channel_id
  }
}

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
# Workflow to route alerts to notification channels
# =============================================================================
resource "newrelic_workflow" "lattice_alerts" {
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

  # Slack destination (if configured)
  dynamic "destination" {
    for_each = var.slack_channel_id != "" ? [1] : []
    content {
      channel_id = newrelic_notification_channel.slack[0].id
    }
  }

  # PagerDuty destination (if configured)
  dynamic "destination" {
    for_each = var.pagerduty_service_key != "" ? [1] : []
    content {
      channel_id = newrelic_notification_channel.pagerduty[0].id
    }
  }
}
