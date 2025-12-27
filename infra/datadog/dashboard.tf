# =============================================================================
# Lattice Workers Dashboard (Datadog Provider v3.83 compatible)
# =============================================================================

resource "datadog_dashboard" "lattice_workers" {
  title       = "Lattice Worker Health"
  description = "Observability dashboard for Lattice Kafka workers - managed by Terraform"
  layout_type = "ordered"

  # ============================================================
  # ROW 1: Health Overview
  # ============================================================

  widget {
    group_definition {
      title            = "🏥 Service Health Overview"
      layout_type      = "ordered"
      background_color = "blue"

      # Active Workers Count
      widget {
        query_value_definition {
          title       = "Active Workers"
          title_size  = "16"
          title_align = "left"

          request {
            log_query {
              index        = "*"
              search_query = "@event:lattice.worker.started service:(${local.services_query})"

              compute_query {
                aggregation = "cardinality"
                facet       = "service"
              }
            }
          }

          autoscale   = true
          precision   = 0
          text_align  = "center"
        }
      }

      # Error Count (last hour)
      widget {
        query_value_definition {
          title       = "Errors (1h)"
          title_size  = "16"
          title_align = "left"

          request {
            log_query {
              index        = "*"
              search_query = "level:error service:(${local.services_query})"

              compute_query {
                aggregation = "count"
              }
            }
          }

          autoscale  = true
          precision  = 0
          text_align = "center"
        }
      }

      # DLQ Count (last 24h)
      widget {
        query_value_definition {
          title       = "DLQ (24h)"
          title_size  = "16"
          title_align = "left"

          request {
            log_query {
              index        = "*"
              search_query = "@event:lattice.message.dlq service:(${local.services_query})"

              compute_query {
                aggregation = "count"
              }
            }
          }

          autoscale  = true
          precision  = 0
          text_align = "center"
        }
      }

      # Messages Processed (last hour)
      widget {
        query_value_definition {
          title       = "Processed (1h)"
          title_size  = "16"
          title_align = "left"

          request {
            log_query {
              index        = "*"
              search_query = "@event:lattice.message.processed service:(${local.services_query})"

              compute_query {
                aggregation = "count"
              }
            }
          }

          autoscale  = true
          precision  = 0
          text_align = "center"
        }
      }

      # Error Rate Timeseries
      widget {
        timeseries_definition {
          title       = "Error Rate by Service"
          title_size  = "16"
          title_align = "left"
          show_legend = true
          legend_layout = "auto"
          legend_columns = ["avg", "sum"]

          request {
            log_query {
              index        = "*"
              search_query = "level:error service:(${local.services_query})"

              compute_query {
                aggregation = "count"
              }

              group_by {
                facet = "service"
                limit = 10
                sort_query {
                  aggregation = "count"
                  order       = "desc"
                }
              }
            }

            display_type = "line"
            style {
              palette    = "warm"
              line_type  = "solid"
              line_width = "normal"
            }
          }

          yaxis {
            min           = "0"
            include_zero  = true
          }
        }
      }
    }
  }

  # ============================================================
  # ROW 2: Pipeline Throughput
  # ============================================================

  widget {
    group_definition {
      title            = "📊 Pipeline Throughput"
      layout_type      = "ordered"
      background_color = "green"

      # Messages Processed by Stage
      widget {
        timeseries_definition {
          title       = "Messages Processed by Stage"
          title_size  = "16"
          title_align = "left"
          show_legend = true
          legend_layout = "auto"
          legend_columns = ["avg", "sum"]

          request {
            log_query {
              index        = "*"
              search_query = "@event:lattice.message.processed service:(${local.services_query})"

              compute_query {
                aggregation = "count"
              }

              group_by {
                facet = "@stage"
                limit = 10
                sort_query {
                  aggregation = "count"
                  order       = "desc"
                }
              }
            }

            display_type = "area"
            style {
              palette    = "semantic"
              line_type  = "solid"
              line_width = "normal"
            }
          }

          yaxis {
            min           = "0"
            include_zero  = true
          }
        }
      }

      # Processing Latency by Service
      widget {
        timeseries_definition {
          title       = "Avg Processing Latency (ms)"
          title_size  = "16"
          title_align = "left"
          show_legend = true
          legend_layout = "auto"
          legend_columns = ["avg", "max"]

          request {
            log_query {
              index        = "*"
              search_query = "@event:lattice.message.processed @duration_ms:* service:(${local.services_query})"

              compute_query {
                aggregation = "avg"
                facet       = "@duration_ms"
              }

              group_by {
                facet = "service"
                limit = 10
                sort_query {
                  aggregation = "avg"
                  facet       = "@duration_ms"
                  order       = "desc"
                }
              }
            }

            display_type = "line"
            style {
              palette    = "purple"
              line_type  = "solid"
              line_width = "normal"
            }
          }

          yaxis {
            min           = "0"
            include_zero  = true
          }
        }
      }
    }
  }

  # ============================================================
  # ROW 3: Error Analysis
  # ============================================================

  widget {
    group_definition {
      title            = "🔴 Error Analysis"
      layout_type      = "ordered"
      background_color = "orange"

      # Top Errors by Code
      widget {
        toplist_definition {
          title       = "Top Errors by Code"
          title_size  = "16"
          title_align = "left"

          request {
            log_query {
              index        = "*"
              search_query = "level:error service:(${local.services_query}) @error_code:*"

              compute_query {
                aggregation = "count"
              }

              group_by {
                facet = "@error_code"
                limit = 10
                sort_query {
                  aggregation = "count"
                  order       = "desc"
                }
              }
            }
          }
        }
      }

      # Recent DLQ Entries
      widget {
        log_stream_definition {
          title        = "Recent DLQ Entries"
          title_size   = "16"
          title_align  = "left"
          indexes      = ["*"]
          query        = "@event:lattice.message.dlq service:(${local.services_query})"
          columns      = ["service", "@error_code", "@reason"]
          show_date_column    = true
          show_message_column = true
          message_display     = "inline"
          sort {
            column = "time"
            order  = "desc"
          }
        }
      }

      # Errors by Service
      widget {
        toplist_definition {
          title       = "Errors by Service"
          title_size  = "16"
          title_align = "left"

          request {
            log_query {
              index        = "*"
              search_query = "level:error service:(${local.services_query})"

              compute_query {
                aggregation = "count"
              }

              group_by {
                facet = "service"
                limit = 10
                sort_query {
                  aggregation = "count"
                  order       = "desc"
                }
              }
            }
          }
        }
      }
    }
  }

  # ============================================================
  # ROW 4: Infrastructure / Connectivity
  # ============================================================

  widget {
    group_definition {
      title            = "🔌 Infrastructure & Connectivity"
      layout_type      = "ordered"
      background_color = "purple"

      # Kafka Connection Events
      widget {
        timeseries_definition {
          title       = "Kafka Connection Events"
          title_size  = "16"
          title_align = "left"
          show_legend = true
          legend_layout = "auto"

          request {
            log_query {
              index        = "*"
              search_query = "@event:(lattice.kafka.connected OR lattice.kafka.error) service:(${local.services_query})"

              compute_query {
                aggregation = "count"
              }

              group_by {
                facet = "@event"
                limit = 5
                sort_query {
                  aggregation = "count"
                  order       = "desc"
                }
              }
            }

            display_type = "bars"
            style {
              palette = "semantic"
            }
          }
        }
      }

      # Worker Lifecycle Events
      widget {
        timeseries_definition {
          title       = "Worker Lifecycle Events"
          title_size  = "16"
          title_align = "left"
          show_legend = true
          legend_layout = "auto"

          request {
            log_query {
              index        = "*"
              search_query = "@event:(lattice.worker.started OR lattice.worker.shutdown*) service:(${local.services_query})"

              compute_query {
                aggregation = "count"
              }

              group_by {
                facet = "@event"
                limit = 5
                sort_query {
                  aggregation = "count"
                  order       = "desc"
                }
              }
            }

            display_type = "bars"
            style {
              palette = "cool"
            }
          }
        }
      }

      # Connection Errors Stream
      widget {
        log_stream_definition {
          title        = "Connection Errors"
          title_size   = "16"
          title_align  = "left"
          indexes      = ["*"]
          query        = "service:(${local.services_query}) (ETIMEDOUT OR ECONNREFUSED OR connection error)"
          columns      = ["service", "message"]
          show_date_column    = true
          show_message_column = true
          message_display     = "inline"
          sort {
            column = "time"
            order  = "desc"
          }
        }
      }
    }
  }

  # ============================================================
  # Template Variables
  # ============================================================

  template_variable {
    name             = "env"
    prefix           = "env"
    available_values = ["local", "staging", "production"]
    default          = "*"
  }

  template_variable {
    name    = "service"
    prefix  = "service"
    default = "*"
  }

  template_variable {
    name    = "stage"
    prefix  = "@stage"
    default = "*"
  }

  tags = ["team:platform", "env:production"]
}
