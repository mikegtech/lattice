# =============================================================================
# Datadog Log Pipeline for Lattice Workers
# =============================================================================

resource "datadog_logs_custom_pipeline" "lattice_workers" {
  name       = "Lattice Worker Logs"
  is_enabled = true

  filter {
    query = "service:(${local.services_query})"
  }

  # Processor 1: Remap level to status for Datadog
  processor {
    attribute_remapper {
      name            = "Remap level to status"
      is_enabled      = true
      sources         = ["level"]
      target          = "status"
      target_type     = "attribute"
      preserve_source = true
      source_type     = "attribute"
    }
  }

  # Processor 2: Remap event name for Datadog event tracking
  processor {
    attribute_remapper {
      name            = "Remap event to evt.name"
      is_enabled      = true
      sources         = ["event"]
      target          = "evt.name"
      target_type     = "attribute"
      preserve_source = true
      source_type     = "attribute"
    }
  }

  # Processor 3: Category processor for log tiers
  processor {
    category_processor {
      name       = "Categorize by tier"
      is_enabled = true
      target     = "log_category"

      category {
        name = "critical"
        filter {
          query = "@tier:critical"
        }
      }
      category {
        name = "operational"
        filter {
          query = "@tier:operational"
        }
      }
      category {
        name = "lifecycle"
        filter {
          query = "@tier:lifecycle"
        }
      }
      category {
        name = "debug"
        filter {
          query = "@tier:debug"
        }
      }
    }
  }

  # Processor 4: Status remapper for log level colors
  processor {
    status_remapper {
      name       = "Set log status from level"
      is_enabled = true
      sources    = ["level", "status"]
    }
  }

  # Processor 5: Date remapper for timestamp
  processor {
    date_remapper {
      name       = "Use log timestamp"
      is_enabled = true
      sources    = ["timestamp", "time", "@timestamp"]
    }
  }

  # Processor 6: Service remapper
  processor {
    service_remapper {
      name       = "Set service name"
      is_enabled = true
      sources    = ["service", "dd.service"]
    }
  }

  # Processor 7: Extract error_code as facet-friendly attribute
  processor {
    attribute_remapper {
      name            = "Extract error_code"
      is_enabled      = true
      sources         = ["error_code", "err.code", "errorCode"]
      target          = "error.code"
      target_type     = "attribute"
      preserve_source = true
      source_type     = "attribute"
    }
  }

  # Processor 8: Extract duration_ms for performance tracking
  processor {
    attribute_remapper {
      name            = "Extract duration_ms"
      is_enabled      = true
      sources         = ["duration_ms", "durationMs", "latency_ms"]
      target          = "duration"
      target_type     = "attribute"
      preserve_source = true
      source_type     = "attribute"
    }
  }
}

# =============================================================================
# Log-based Metrics for Performance Monitoring
# =============================================================================

resource "datadog_logs_metric" "processing_duration" {
  name = "lattice.processing.duration_ms"

  compute {
    aggregation_type = "distribution"
    path             = "@duration_ms"
  }

  filter {
    query = "@event:lattice.message.processed"
  }

  group_by {
    path     = "service"
    tag_name = "service"
  }

  group_by {
    path     = "@stage"
    tag_name = "stage"
  }
}

resource "datadog_logs_metric" "dlq_count" {
  name = "lattice.dlq.count"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "@event:lattice.message.dlq"
  }

  group_by {
    path     = "service"
    tag_name = "service"
  }

  group_by {
    path     = "@error_code"
    tag_name = "error_code"
  }
}

resource "datadog_logs_metric" "messages_processed" {
  name = "lattice.messages.processed"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "@event:lattice.message.processed"
  }

  group_by {
    path     = "service"
    tag_name = "service"
  }

  group_by {
    path     = "@stage"
    tag_name = "stage"
  }
}

resource "datadog_logs_metric" "errors_count" {
  name = "lattice.errors.count"

  compute {
    aggregation_type = "count"
  }

  filter {
    query = "service:(${local.services_query}) level:error"
  }

  group_by {
    path     = "service"
    tag_name = "service"
  }

  group_by {
    path     = "@error_code"
    tag_name = "error_code"
  }
}
