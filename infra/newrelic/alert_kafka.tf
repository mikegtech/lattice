# =============================================================================
# Kafka Monitors
# =============================================================================

resource "newrelic_nrql_alert_condition" "kafka_connection_errors" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] Kafka Connection Errors"
  description                  = "Triggers when Kafka connection errors occur - check broker health"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE (message LIKE '%kafka%' AND message LIKE '%error%')
        OR (message LIKE '%broker%' AND message LIKE '%disconnect%')
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
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

resource "newrelic_nrql_alert_condition" "consumer_timeout" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] Consumer Timeout"
  description                  = "Triggers when Kafka consumer times out - may need rebalance"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT count(*)
      FROM Log
      WHERE message LIKE '%timeout%' AND message LIKE '%consumer%'
        AND (${local.services_filter})
      FACET appName
    NRQL
  }

  warning {
    operator              = "above"
    threshold             = 3
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 300
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}
