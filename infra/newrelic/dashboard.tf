# =============================================================================
# Lattice Workers Dashboard
# =============================================================================

resource "newrelic_one_dashboard" "lattice_workers" {
  name        = "Lattice Worker Health"
  permissions = "public_read_write"

  # ============================================================
  # Page 1: Overview
  # ============================================================
  page {
    name = "Overview"

    # Active Workers Billboard
    widget_billboard {
      title  = "Active Workers"
      row    = 1
      column = 1
      width  = 3
      height = 2

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT uniqueCount(appName)
          FROM Transaction
          WHERE (${local.services_filter})
          SINCE 5 minutes ago
        NRQL
      }
    }

    # Error Count Billboard
    widget_billboard {
      title  = "Errors (1h)"
      row    = 1
      column = 4
      width  = 3
      height = 2

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT count(*)
          FROM Log
          WHERE level = 'error'
            AND (${local.services_filter})
          SINCE 1 hour ago
        NRQL
      }

      critical = 50
      warning  = 20
    }

    # Throughput Billboard
    widget_billboard {
      title  = "Throughput (1h)"
      row    = 1
      column = 7
      width  = 3
      height = 2

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT count(*)
          FROM Transaction
          WHERE (${local.services_filter})
          SINCE 1 hour ago
        NRQL
      }
    }

    # Avg Response Time Billboard
    widget_billboard {
      title  = "Avg Latency (ms)"
      row    = 1
      column = 10
      width  = 3
      height = 2

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT average(duration)
          FROM Transaction
          WHERE (${local.services_filter})
          SINCE 1 hour ago
        NRQL
      }

      critical = 30000
      warning  = 10000
    }

    # Error Rate by Service - Line Chart
    widget_line {
      title  = "Error Rate by Service"
      row    = 3
      column = 1
      width  = 6
      height = 3

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT count(*)
          FROM Log
          WHERE level = 'error'
            AND (${local.services_filter})
          FACET appName
          TIMESERIES AUTO
        NRQL
      }
    }

    # Throughput by Service - Line Chart
    widget_line {
      title  = "Throughput by Service"
      row    = 3
      column = 7
      width  = 6
      height = 3

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT count(*)
          FROM Transaction
          WHERE (${local.services_filter})
          FACET appName
          TIMESERIES AUTO
        NRQL
      }
    }

    # Latency Distribution - Histogram
    widget_histogram {
      title  = "Latency Distribution"
      row    = 6
      column = 1
      width  = 6
      height = 3

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT histogram(duration, 50, 10)
          FROM Transaction
          WHERE (${local.services_filter})
          SINCE 1 hour ago
        NRQL
      }
    }

    # Service Health Table
    widget_table {
      title  = "Service Health"
      row    = 6
      column = 7
      width  = 6
      height = 3

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT count(*) as 'Transactions',
                 average(duration) as 'Avg Latency (ms)',
                 percentage(count(*), WHERE error IS true) as 'Error %'
          FROM Transaction
          WHERE (${local.services_filter})
          FACET appName
          SINCE 1 hour ago
        NRQL
      }
    }
  }

  # ============================================================
  # Page 2: Kafka & Processing
  # ============================================================
  page {
    name = "Kafka & Processing"

    # Messages Processed - Timeseries
    widget_line {
      title  = "Messages Processed"
      row    = 1
      column = 1
      width  = 12
      height = 3

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT count(*)
          FROM Transaction
          WHERE (${local.services_filter})
          FACET appName
          TIMESERIES AUTO
        NRQL
      }
    }

    # Processing Latency P95
    widget_line {
      title  = "Processing Latency (P95)"
      row    = 4
      column = 1
      width  = 6
      height = 3

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT percentile(duration, 95)
          FROM Transaction
          WHERE (${local.services_filter})
          FACET appName
          TIMESERIES AUTO
        NRQL
      }
    }

    # Error by Type
    widget_pie {
      title  = "Errors by Type"
      row    = 4
      column = 7
      width  = 6
      height = 3

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT count(*)
          FROM Log
          WHERE level = 'error'
            AND (${local.services_filter})
          FACET error.class
          SINCE 24 hours ago
        NRQL
      }
    }
  }

  # ============================================================
  # Page 3: Logs
  # ============================================================
  page {
    name = "Logs"

    # Log Volume by Level
    widget_area {
      title  = "Log Volume by Level"
      row    = 1
      column = 1
      width  = 12
      height = 3

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT count(*)
          FROM Log
          WHERE (${local.services_filter})
          FACET level
          TIMESERIES AUTO
        NRQL
      }
    }

    # Recent Errors Table
    widget_table {
      title  = "Recent Errors"
      row    = 4
      column = 1
      width  = 12
      height = 4

      nrql_query {
        account_id = var.newrelic_account_id
        query      = <<-NRQL
          SELECT timestamp, appName, message
          FROM Log
          WHERE level = 'error'
            AND (${local.services_filter})
          SINCE 1 hour ago
          LIMIT 100
        NRQL
      }
    }
  }
}
