# =============================================================================
# Latency Monitors
# =============================================================================

resource "newrelic_nrql_alert_condition" "processing_latency" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] High Processing Latency"
  description                  = "Triggers when message processing takes too long"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT percentile(duration, 95) / 1000 as 'p95_seconds'
      FROM Transaction
      WHERE (${local.services_filter})
      FACET appName
    NRQL
  }

  critical {
    operator              = "above"
    threshold             = 30
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  warning {
    operator              = "above"
    threshold             = 10
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 300
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}

resource "newrelic_nrql_alert_condition" "embedding_latency" {
  account_id                   = var.newrelic_account_id
  policy_id                    = newrelic_alert_policy.lattice_workers.id
  name                         = "[Lattice] High Embedding Latency"
  description                  = "Triggers when embedding generation is slow - check embedding service"
  type                         = "static"
  enabled                      = true
  violation_time_limit_seconds = 3600

  nrql {
    query = <<-NRQL
      SELECT percentile(duration, 95) / 1000 as 'p95_seconds'
      FROM Transaction
      WHERE appName = 'lattice-worker-mail-embedder'
    NRQL
  }

  critical {
    operator              = "above"
    threshold             = 60
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  warning {
    operator              = "above"
    threshold             = 30
    threshold_duration    = 300
    threshold_occurrences = "all"
  }

  fill_option        = "none"
  aggregation_window = 300
  aggregation_method = "event_flow"
  aggregation_delay  = 60
}
