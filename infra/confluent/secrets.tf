# =============================================================================
# Data Plane Credentials (CI Kafka API Key)
# =============================================================================
# These credentials are used for Kafka data-plane operations:
# - Topic creation/management
# - ACL management
#
# The CI Kafka API key is owned by service account lattice-ci-kafka and must
# be pre-created in Confluent Cloud Console and stored in GCP Secret Manager.
# =============================================================================

data "google_secret_manager_secret_version" "ci_kafka_api_key" {
  secret  = var.ci_kafka_api_key_secret_name
  project = var.gcp_project_id
}

data "google_secret_manager_secret_version" "ci_kafka_api_secret" {
  secret  = var.ci_kafka_api_secret_secret_name
  project = var.gcp_project_id
}
