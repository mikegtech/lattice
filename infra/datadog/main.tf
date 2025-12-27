provider "datadog" {
  api_key = var.datadog_api_key
  app_key = var.datadog_app_key
  api_url = var.datadog_api_url
}

locals {
  common_tags = [
    "team:${var.team}",
    "managed-by:terraform",
    "project:lattice"
  ]

  lattice_services = [
    "lattice-worker-mail-parser",
    "lattice-worker-mail-chunker",
    "lattice-worker-mail-embedder",
    "lattice-worker-mail-upserter",
    "lattice-worker-mail-deleter",
    "lattice-worker-audit-writer"
  ]

  services_query = join(" OR ", local.lattice_services)

  # Notification targets - all flow through Datadog
  notify_slack_alerts   = var.slack_channel != "" ? "@slack-${replace(var.slack_channel, "#", "")}" : ""
  notify_pagerduty      = var.pagerduty_service != "" ? "@pagerduty-${var.pagerduty_service}" : ""
  notify_critical       = var.pagerduty_service != "" ? local.notify_pagerduty : local.notify_slack_alerts
}
