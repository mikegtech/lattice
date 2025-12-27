output "pipeline_id" {
  description = "ID of the Lattice logs pipeline"
  value       = datadog_logs_custom_pipeline.lattice_workers.id
}

output "pipeline_name" {
  description = "Name of the Lattice logs pipeline"
  value       = datadog_logs_custom_pipeline.lattice_workers.name
}

output "dashboard_url" {
  description = "URL to the Lattice Workers dashboard"
  value       = "https://app.datadoghq.com${datadog_dashboard.lattice_workers.url}"
}

output "monitor_ids" {
  description = "Map of monitor names to IDs"
  value = {
    dlq_spike              = datadog_monitor.dlq_spike.id
    dlq_schema_errors      = datadog_monitor.dlq_schema_errors.id
    error_rate             = datadog_monitor.error_rate.id
    sustained_errors       = datadog_monitor.sustained_errors.id
    worker_no_logs         = datadog_monitor.worker_no_logs.id
    kafka_connection_error = datadog_monitor.kafka_connection_error.id
    processing_latency     = datadog_monitor.processing_latency_p95.id
  }
}
