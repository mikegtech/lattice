# =============================================================================
# Outputs
# =============================================================================

# -----------------------------------------------------------------------------
# Cluster Information
# -----------------------------------------------------------------------------

output "confluent_environment_id" {
  description = "Confluent Cloud environment ID"
  value       = local.environment_id
}

output "kafka_cluster_id" {
  description = "Kafka cluster ID"
  value       = local.kafka_cluster_id
}

output "kafka_bootstrap_endpoint" {
  description = "Kafka bootstrap endpoint for client connections"
  value       = local.kafka_bootstrap_endpoint
}

output "kafka_rest_endpoint" {
  description = "Kafka REST endpoint"
  value       = local.kafka_rest_endpoint
}

# -----------------------------------------------------------------------------
# Service Account Information
# -----------------------------------------------------------------------------

output "service_account_worker_id" {
  description = "Worker service account ID"
  value       = local.worker_service_account_id
}

# -----------------------------------------------------------------------------
# Secret Manager Resource Names (for retrieval)
# -----------------------------------------------------------------------------

output "worker_kafka_api_key_secret_name" {
  description = "GCP Secret Manager secret name for worker Kafka API key"
  value       = "lattice-worker-kafka-api-key"
}

output "worker_kafka_api_secret_secret_name" {
  description = "GCP Secret Manager secret name for worker Kafka API secret"
  value       = "lattice-worker-kafka-api-secret"
}

# Full resource names for programmatic access
output "worker_kafka_api_key_secret_resource" {
  description = "Full GCP Secret Manager resource name for worker Kafka API key"
  value       = local.worker_kafka_api_key_secret_id
}

output "worker_kafka_api_secret_secret_resource" {
  description = "Full GCP Secret Manager resource name for worker Kafka API secret"
  value       = local.worker_kafka_api_secret_secret_id
}

# -----------------------------------------------------------------------------
# Topic Information
# -----------------------------------------------------------------------------

output "topic_names" {
  description = "List of all provisioned Kafka topics"
  value       = keys(confluent_kafka_topic.topics)
}

output "primary_topic_names" {
  description = "List of primary (non-DLQ) topic names"
  value       = var.topics
}

output "dlq_topic_names" {
  description = "List of DLQ topic names"
  value       = var.dlq_topics
}
