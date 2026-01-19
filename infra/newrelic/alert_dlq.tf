# =============================================================================
# DLQ (Dead Letter Queue) Monitors
# =============================================================================

resource "newrelic_nrql_alert_condition" "dlq_spike" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] DLQ Spike"
  description                  = "Triggers when DLQ message count spikes - indicates processing failures"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE message LIKE '%dlq%' OR message LIKE '%dead.letter%'
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
    operator              = "above"
    threshold             = 10
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  warning {
    operator              = "above"
    threshold             = 5
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 300
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}

resource "newrelic_nrql_alert_condition" "dlq_schema_errors" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] DLQ Schema Errors"
  description                  = "Triggers when schema validation errors send messages to DLQ"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE message LIKE '%schema%' AND message LIKE '%error%'
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
    operator              = "above"
    threshold             = 5
    threshold_duration    = 600
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 600
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}
