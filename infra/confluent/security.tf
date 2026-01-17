# =============================================================================
# Confluent Cloud Service Accounts and Access Control
# =============================================================================
#
# Design:
# - Control plane: Confluent Cloud API key from GCP Secret Manager (providers.tf)
# - Data plane: CI Kafka API key from GCP Secret Manager (secrets.tf)
# - Terraform manages worker service account + Kafka API key
# - Worker Kafka API key secret is stored in GCP Secret Manager
# - ACLs provide least-privilege access to specific topics
#
# =============================================================================

# -----------------------------------------------------------------------------
# Service Accounts
# -----------------------------------------------------------------------------

# Worker service account - shared by all workers
# Can be split to per-worker service accounts if needed for finer access control
resource "confluent_service_account" "worker" {
  display_name = "lattice-worker"
  description  = "Service account for Lattice Kafka workers"
}

# -----------------------------------------------------------------------------
# Worker Kafka API Key
# -----------------------------------------------------------------------------

resource "confluent_api_key" "worker" {
  display_name = "lattice-worker-kafka-api-key"
  description  = "Kafka API key for Lattice workers"

  owner {
    id          = confluent_service_account.worker.id
    api_version = confluent_service_account.worker.api_version
    kind        = confluent_service_account.worker.kind
  }

  managed_resource {
    id          = confluent_kafka_cluster.this.id
    api_version = confluent_kafka_cluster.this.api_version
    kind        = confluent_kafka_cluster.this.kind

    environment {
      id = confluent_environment.this.id
    }
  }

  depends_on = [
    confluent_kafka_acl.worker_consumer_group,
    confluent_kafka_acl.worker_read_topics,
    confluent_kafka_acl.worker_write_topics,
    confluent_kafka_acl.worker_write_dlq,
  ]
}

# -----------------------------------------------------------------------------
# Kafka ACLs - Least Privilege for Workers
# -----------------------------------------------------------------------------

# Worker can use consumer groups with prefix "lattice-"
resource "confluent_kafka_acl" "worker_consumer_group" {
  kafka_cluster {
    id = confluent_kafka_cluster.this.id
  }
  resource_type = "GROUP"
  resource_name = "lattice-"
  pattern_type  = "PREFIXED"
  principal     = "User:${confluent_service_account.worker.id}"
  host          = "*"
  operation     = "READ"
  permission    = "ALLOW"

  credentials {
    key    = data.google_secret_manager_secret_version.ci_kafka_api_key.secret_data
    secret = data.google_secret_manager_secret_version.ci_kafka_api_secret.secret_data
  }
}

# Worker can read from all lattice.* topics (primary topics)
resource "confluent_kafka_acl" "worker_read_topics" {
  kafka_cluster {
    id = confluent_kafka_cluster.this.id
  }
  resource_type = "TOPIC"
  resource_name = "lattice."
  pattern_type  = "PREFIXED"
  principal     = "User:${confluent_service_account.worker.id}"
  host          = "*"
  operation     = "READ"
  permission    = "ALLOW"

  credentials {
    key    = data.google_secret_manager_secret_version.ci_kafka_api_key.secret_data
    secret = data.google_secret_manager_secret_version.ci_kafka_api_secret.secret_data
  }
}

# Worker can write to all lattice.* topics (output topics)
resource "confluent_kafka_acl" "worker_write_topics" {
  kafka_cluster {
    id = confluent_kafka_cluster.this.id
  }
  resource_type = "TOPIC"
  resource_name = "lattice."
  pattern_type  = "PREFIXED"
  principal     = "User:${confluent_service_account.worker.id}"
  host          = "*"
  operation     = "WRITE"
  permission    = "ALLOW"

  credentials {
    key    = data.google_secret_manager_secret_version.ci_kafka_api_key.secret_data
    secret = data.google_secret_manager_secret_version.ci_kafka_api_secret.secret_data
  }
}

# Worker can write to DLQ topics (lattice.dlq.*)
resource "confluent_kafka_acl" "worker_write_dlq" {
  kafka_cluster {
    id = confluent_kafka_cluster.this.id
  }
  resource_type = "TOPIC"
  resource_name = "lattice.dlq."
  pattern_type  = "PREFIXED"
  principal     = "User:${confluent_service_account.worker.id}"
  host          = "*"
  operation     = "WRITE"
  permission    = "ALLOW"

  credentials {
    key    = data.google_secret_manager_secret_version.ci_kafka_api_key.secret_data
    secret = data.google_secret_manager_secret_version.ci_kafka_api_secret.secret_data
  }
}

# -----------------------------------------------------------------------------
# GCP Secret Manager - Store Worker Kafka Credentials
# -----------------------------------------------------------------------------

# Secret for worker Kafka API key ID
resource "google_secret_manager_secret" "worker_kafka_api_key" {
  secret_id = "lattice-worker-kafka-api-key"
  project   = var.gcp_project_id

  replication {
    auto {}
  }

  labels = {
    managed-by = "terraform"
    service    = "confluent"
    component  = "worker"
  }
}

resource "google_secret_manager_secret_version" "worker_kafka_api_key" {
  secret      = google_secret_manager_secret.worker_kafka_api_key.id
  secret_data = confluent_api_key.worker.id
}

# Secret for worker Kafka API secret
resource "google_secret_manager_secret" "worker_kafka_api_secret" {
  secret_id = "lattice-worker-kafka-api-secret"
  project   = var.gcp_project_id

  replication {
    auto {}
  }

  labels = {
    managed-by = "terraform"
    service    = "confluent"
    component  = "worker"
  }
}

resource "google_secret_manager_secret_version" "worker_kafka_api_secret" {
  secret      = google_secret_manager_secret.worker_kafka_api_secret.id
  secret_data = confluent_api_key.worker.secret
}
