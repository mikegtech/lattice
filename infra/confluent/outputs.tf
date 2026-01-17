output "confluent_environment_id" {
  description = "Confluent Cloud environment ID"
  value       = confluent_environment.this.id
}

output "kafka_cluster_id" {
  description = "Kafka cluster ID"
  value       = confluent_kafka_cluster.this.id
}

output "kafka_bootstrap_endpoint" {
  description = "Kafka bootstrap endpoint for client connections"
  value       = confluent_kafka_cluster.this.bootstrap_endpoint
}

output "kafka_rest_endpoint" {
  description = "Kafka REST endpoint"
  value       = confluent_kafka_cluster.this.rest_endpoint
}

# Service account IDs (non-sensitive)
output "service_account_app_manager_id" {
  description = "App manager service account ID"
  value       = confluent_service_account.app_manager.id
}

output "service_account_ci_id" {
  description = "CI service account ID"
  value       = confluent_service_account.ci.id
}

output "service_account_worker_id" {
  description = "Worker service account ID"
  value       = confluent_service_account.worker.id
}

# API key IDs (non-sensitive, secrets are not exposed)
output "api_key_worker_id" {
  description = "Worker API key ID (use with KAFKA_API_KEY env var)"
  value       = confluent_api_key.worker.id
}

# Worker API key secret - marked sensitive, use carefully
output "api_key_worker_secret" {
  description = "Worker API key secret (sensitive - store in Secret Manager)"
  value       = confluent_api_key.worker.secret
  sensitive   = true
}

# Topic names for reference
output "topic_names" {
  description = "List of all provisioned Kafka topics"
  value       = keys(confluent_kafka_topic.topics)
}
