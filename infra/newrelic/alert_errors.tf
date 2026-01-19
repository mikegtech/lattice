# =============================================================================
# Error Rate Monitors (NRQL Alert Conditions)
# =============================================================================

resource "newrelic_nrql_alert_condition" "error_rate" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] High Error Rate"
  description                  = "Triggers when error count exceeds threshold in last 5 minutes"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE level = 'error'
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
    operator              = "above"
    threshold             = 50
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  warning {
    operator              = "above"
    threshold             = 20
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 300
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}

resource "newrelic_nrql_alert_condition" "sustained_errors" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] Sustained Errors"
  description                  = "Triggers when errors persist over 30 minutes - indicates ongoing issue"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 7200

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE level = 'error'
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
    operator              = "above"
    threshold             = 100
    threshold_duration    = 1800
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 1800
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}

resource "newrelic_nrql_alert_condition" "error_spike" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] Error Spike"
  description                  = "Triggers when error rate spikes above baseline - anomaly detection"
  type                         = "baseline"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE level = 'error'
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
    operator              = "above"
    threshold             = 3
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  baseline_direction = "upper_only"
  fill_option        = "none"
  aggregation_window = 300
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}
