# =============================================================================
# Availability Monitors
# =============================================================================

resource "newrelic_nrql_alert_condition" "worker_no_logs" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] Worker No Logs"
  description                  = "Triggers when a worker stops logging - may indicate crash or freeze"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
    operator              = "below"
    threshold             = 1
    threshold_duration    = 600
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 600
  aggregation_method = "event_flow"
  aggregation_delay  = 120
}

resource "newrelic_nrql_alert_condition" "worker_shutdown" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] Worker Shutdown Detected"
  description                  = "Triggers when worker graceful shutdown is detected"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 1800

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE message LIKE '%shutdown%' OR message LIKE '%SIGTERM%'
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  warning {
    operator              = "above"
    threshold             = 1
    threshold_duration    = 60
    threshold_occurrences = "at_least_once"
  }

  fill_option        = "none"
  aggregation_window = 60
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}

resource "newrelic_nrql_alert_condition" "multiple_restarts" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] Multiple Restarts"
  description                  = "Triggers when worker restarts multiple times - indicates instability"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE message LIKE '%started%' OR message LIKE '%initialized%'
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
    operator              = "above"
    threshold             = 5
    threshold_duration    = 1800
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 1800
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}
