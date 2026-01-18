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

# Data source for existing service account (used when importing)
data "confluent_service_account" "worker" {
  count = var.import_existing_service_account ? 1 : 0
  id    = var.existing_service_account_id
}

# Worker service account - shared by all workers
# Only create if not importing existing
resource "confluent_service_account" "worker" {
  count        = var.import_existing_service_account ? 0 : 1
  display_name = "lattice-worker"
  description  = "Service account for Lattice Kafka workers"
}

# Local to reference the service account regardless of whether it's imported or created
locals {
  worker_service_account_id          = var.import_existing_service_account ? data.confluent_service_account.worker[0].id : confluent_service_account.worker[0].id
  worker_service_account_api_version = var.import_existing_service_account ? data.confluent_service_account.worker[0].api_version : confluent_service_account.worker[0].api_version
  worker_service_account_kind        = var.import_existing_service_account ? data.confluent_service_account.worker[0].kind : confluent_service_account.worker[0].kind
}

# -----------------------------------------------------------------------------
# Worker Kafka API Key
# -----------------------------------------------------------------------------

resource "confluent_api_key" "worker" {
  display_name = "lattice-worker-kafka-api-key"
  description  = "Kafka API key for Lattice workers"

  owner {
    id          = local.worker_service_account_id
    api_version = local.worker_service_account_api_version
    kind        = local.worker_service_account_kind
  }

  managed_resource {
    id          = confluent_kafka_cluster.this.id
    api_version = confluent_kafka_cluster.this.api_version
    kind        = confluent_kafka_cluster.this.kind

    environment {
      id = confluent_environment.this.id
    }
  }

  # Force recreation when rotation is requested
  lifecycle {
    replace_triggered_by = [
      null_resource.api_key_rotation_trigger
    ]
  }

  depends_on = [
    confluent_kafka_acl.worker_consumer_group,
    confluent_kafka_acl.worker_read_topics,
    confluent_kafka_acl.worker_write_topics,
    confluent_kafka_acl.worker_write_dlq,
  ]
}

# Null resource to trigger API key rotation
resource "null_resource" "api_key_rotation_trigger" {
  triggers = {
    rotate = var.rotate_worker_api_key ? timestamp() : "stable"
  }
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
  principal     = "User:${local.worker_service_account_id}"
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
  principal     = "User:${local.worker_service_account_id}"
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
  principal     = "User:${local.worker_service_account_id}"
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
  principal     = "User:${local.worker_service_account_id}"
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
# Secrets are created once and then versions are added for each API key rotation.
# Uses data sources to check if secrets exist, creates if not.
# -----------------------------------------------------------------------------

# Check if worker secrets already exist
data "google_secret_manager_secret" "worker_kafka_api_key_existing" {
  count     = 1
  secret_id = "lattice-worker-kafka-api-key"
  project   = var.gcp_project_id
}

data "google_secret_manager_secret" "worker_kafka_api_secret_existing" {
  count     = 1
  secret_id = "lattice-worker-kafka-api-secret"
  project   = var.gcp_project_id
}

# Locals to determine if secrets exist
locals {
  worker_api_key_secret_exists    = try(data.google_secret_manager_secret.worker_kafka_api_key_existing[0].id, "") != ""
  worker_api_secret_secret_exists = try(data.google_secret_manager_secret.worker_kafka_api_secret_existing[0].id, "") != ""
}

# Secret for worker Kafka API key ID - only create if doesn't exist
resource "google_secret_manager_secret" "worker_kafka_api_key" {
  count     = local.worker_api_key_secret_exists ? 0 : 1
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

# Secret for worker Kafka API secret - only create if doesn't exist
resource "google_secret_manager_secret" "worker_kafka_api_secret" {
  count     = local.worker_api_secret_secret_exists ? 0 : 1
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

# Local to get the secret ID regardless of whether it was created or already existed
locals {
  worker_kafka_api_key_secret_id = local.worker_api_key_secret_exists ? data.google_secret_manager_secret.worker_kafka_api_key_existing[0].id : google_secret_manager_secret.worker_kafka_api_key[0].id
  worker_kafka_api_secret_secret_id = local.worker_api_secret_secret_exists ? data.google_secret_manager_secret.worker_kafka_api_secret_existing[0].id : google_secret_manager_secret.worker_kafka_api_secret[0].id
}

# Always add new version with the current API key value
resource "google_secret_manager_secret_version" "worker_kafka_api_key" {
  secret      = local.worker_kafka_api_key_secret_id
  secret_data = confluent_api_key.worker.id
}

resource "google_secret_manager_secret_version" "worker_kafka_api_secret" {
  secret      = local.worker_kafka_api_secret_secret_id
  secret_data = confluent_api_key.worker.secret
}
