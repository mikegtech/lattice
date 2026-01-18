# =============================================================================
# Confluent Cloud Service Accounts and Access Control
# =============================================================================
#
# Uses "Lookup First" pattern for service accounts:
# - If existing_service_account_id is provided, use data source
# - If empty, create new service account
# - Locals provide consistent reference
#
# =============================================================================

# -----------------------------------------------------------------------------
# CI Kafka Service Account (for Terraform data-plane operations)
# -----------------------------------------------------------------------------
# This service account owns the API key used for topic and ACL management.
# Terraform fully manages this lifecycle - no manual key creation needed.
# -----------------------------------------------------------------------------

resource "confluent_service_account" "ci_kafka" {
  display_name = "lattice-ci-kafka"
  description  = "Service account for Terraform CI/CD Kafka operations (topics, ACLs)"
}

# -----------------------------------------------------------------------------
# CI Kafka Role Binding (CloudClusterAdmin)
# -----------------------------------------------------------------------------
# Grants the CI Kafka service account admin permissions on the cluster.
# This is required for topic and ACL management via the Kafka API.
# -----------------------------------------------------------------------------

resource "confluent_role_binding" "ci_kafka_cluster_admin" {
  principal   = "User:${confluent_service_account.ci_kafka.id}"
  role_name   = "CloudClusterAdmin"
  crn_pattern = local.use_existing_cluster ? data.confluent_kafka_cluster.existing[0].rbac_crn : confluent_kafka_cluster.this[0].rbac_crn
}

# -----------------------------------------------------------------------------
# CI Kafka API Key (Terraform-managed)
# -----------------------------------------------------------------------------
# This key is used for ALL Kafka data-plane operations in Terraform:
# - Topic creation/management
# - ACL management
# The key is always valid for the current cluster (created or looked up).
# -----------------------------------------------------------------------------

resource "confluent_api_key" "ci_kafka" {
  display_name = "lattice-ci-kafka-api-key"
  description  = "Kafka API key for Terraform CI/CD operations"

  owner {
    id          = confluent_service_account.ci_kafka.id
    api_version = confluent_service_account.ci_kafka.api_version
    kind        = confluent_service_account.ci_kafka.kind
  }

  managed_resource {
    id          = local.kafka_cluster_id
    api_version = local.use_existing_cluster ? data.confluent_kafka_cluster.existing[0].api_version : confluent_kafka_cluster.this[0].api_version
    kind        = local.use_existing_cluster ? data.confluent_kafka_cluster.existing[0].kind : confluent_kafka_cluster.this[0].kind

    environment {
      id = local.environment_id
    }
  }

  # Force recreation when rotation is requested
  lifecycle {
    replace_triggered_by = [
      null_resource.ci_kafka_api_key_rotation_trigger
    ]
  }

  # Ensure role binding exists before creating the API key
  depends_on = [
    confluent_role_binding.ci_kafka_cluster_admin
  ]
}

# Null resource to trigger CI Kafka API key rotation
resource "null_resource" "ci_kafka_api_key_rotation_trigger" {
  triggers = {
    rotate = var.rotate_ci_kafka_api_key ? timestamp() : "stable"
  }
}

# -----------------------------------------------------------------------------
# Worker Service Account
# -----------------------------------------------------------------------------

# Lookup existing service account if ID provided
data "confluent_service_account" "existing" {
  count = var.existing_service_account_id != "" ? 1 : 0
  id    = var.existing_service_account_id
}

# Create new service account if no existing ID
resource "confluent_service_account" "worker" {
  count        = var.existing_service_account_id == "" ? 1 : 0
  display_name = "lattice-worker"
  description  = "Service account for Lattice Kafka workers"
}

# Local references for worker service account
locals {
  use_existing_service_account       = var.existing_service_account_id != ""
  worker_service_account_id          = local.use_existing_service_account ? data.confluent_service_account.existing[0].id : confluent_service_account.worker[0].id
  worker_service_account_api_version = local.use_existing_service_account ? data.confluent_service_account.existing[0].api_version : confluent_service_account.worker[0].api_version
  worker_service_account_kind        = local.use_existing_service_account ? data.confluent_service_account.existing[0].kind : confluent_service_account.worker[0].kind
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
    id          = local.kafka_cluster_id
    api_version = local.use_existing_cluster ? data.confluent_kafka_cluster.existing[0].api_version : confluent_kafka_cluster.this[0].api_version
    kind        = local.use_existing_cluster ? data.confluent_kafka_cluster.existing[0].kind : confluent_kafka_cluster.this[0].kind

    environment {
      id = local.environment_id
    }
  }

  # Force recreation when rotation is requested
  lifecycle {
    replace_triggered_by = [
      null_resource.worker_api_key_rotation_trigger
    ]
  }

  depends_on = [
    confluent_kafka_acl.worker_consumer_group,
    confluent_kafka_acl.worker_read_topics,
    confluent_kafka_acl.worker_write_topics,
    confluent_kafka_acl.worker_write_dlq,
  ]
}

# Null resource to trigger worker API key rotation
resource "null_resource" "worker_api_key_rotation_trigger" {
  triggers = {
    rotate = var.rotate_worker_api_key ? timestamp() : "stable"
  }
}

# -----------------------------------------------------------------------------
# Kafka ACLs - Least Privilege for Workers
# -----------------------------------------------------------------------------
# Note: ACLs use the Terraform-managed CI Kafka API key for authentication.
# -----------------------------------------------------------------------------

# Worker can use consumer groups with prefix "lattice-"
resource "confluent_kafka_acl" "worker_consumer_group" {
  kafka_cluster {
    id = local.kafka_cluster_id
  }
  resource_type = "GROUP"
  resource_name = "lattice-"
  pattern_type  = "PREFIXED"
  principal     = "User:${local.worker_service_account_id}"
  host          = "*"
  operation     = "READ"
  permission    = "ALLOW"
  rest_endpoint = local.kafka_rest_endpoint

  credentials {
    key    = confluent_api_key.ci_kafka.id
    secret = confluent_api_key.ci_kafka.secret
  }

  depends_on = [confluent_role_binding.ci_kafka_cluster_admin]
}

# Worker can read from all lattice.* topics (primary topics)
resource "confluent_kafka_acl" "worker_read_topics" {
  kafka_cluster {
    id = local.kafka_cluster_id
  }
  resource_type = "TOPIC"
  resource_name = "lattice."
  pattern_type  = "PREFIXED"
  principal     = "User:${local.worker_service_account_id}"
  host          = "*"
  operation     = "READ"
  permission    = "ALLOW"
  rest_endpoint = local.kafka_rest_endpoint

  credentials {
    key    = confluent_api_key.ci_kafka.id
    secret = confluent_api_key.ci_kafka.secret
  }

  depends_on = [confluent_role_binding.ci_kafka_cluster_admin]
}

# Worker can write to all lattice.* topics (output topics)
resource "confluent_kafka_acl" "worker_write_topics" {
  kafka_cluster {
    id = local.kafka_cluster_id
  }
  resource_type = "TOPIC"
  resource_name = "lattice."
  pattern_type  = "PREFIXED"
  principal     = "User:${local.worker_service_account_id}"
  host          = "*"
  operation     = "WRITE"
  permission    = "ALLOW"
  rest_endpoint = local.kafka_rest_endpoint

  credentials {
    key    = confluent_api_key.ci_kafka.id
    secret = confluent_api_key.ci_kafka.secret
  }

  depends_on = [confluent_role_binding.ci_kafka_cluster_admin]
}

# Worker can write to DLQ topics (lattice.dlq.*)
resource "confluent_kafka_acl" "worker_write_dlq" {
  kafka_cluster {
    id = local.kafka_cluster_id
  }
  resource_type = "TOPIC"
  resource_name = "lattice.dlq."
  pattern_type  = "PREFIXED"
  principal     = "User:${local.worker_service_account_id}"
  host          = "*"
  operation     = "WRITE"
  permission    = "ALLOW"
  rest_endpoint = local.kafka_rest_endpoint

  credentials {
    key    = confluent_api_key.ci_kafka.id
    secret = confluent_api_key.ci_kafka.secret
  }

  depends_on = [confluent_role_binding.ci_kafka_cluster_admin]
}

# -----------------------------------------------------------------------------
# GCP Secret Manager - CI Kafka Credentials
# -----------------------------------------------------------------------------
# Persists CI Kafka API key to Secret Manager for external reference.
# Uses "check if exists → create if not → always add new version" pattern.
# -----------------------------------------------------------------------------

# Check if CI Kafka secrets already exist
data "google_secret_manager_secret" "ci_kafka_api_key_existing" {
  count     = 1
  secret_id = "lattice-ci-kafka-api-key"
  project   = var.gcp_project_id
}

data "google_secret_manager_secret" "ci_kafka_api_secret_existing" {
  count     = 1
  secret_id = "lattice-ci-kafka-api-secret"
  project   = var.gcp_project_id
}

locals {
  ci_kafka_api_key_secret_exists    = try(data.google_secret_manager_secret.ci_kafka_api_key_existing[0].id, "") != ""
  ci_kafka_api_secret_secret_exists = try(data.google_secret_manager_secret.ci_kafka_api_secret_existing[0].id, "") != ""
}

# Secret for CI Kafka API key ID - only create if doesn't exist
resource "google_secret_manager_secret" "ci_kafka_api_key" {
  count     = local.ci_kafka_api_key_secret_exists ? 0 : 1
  secret_id = "lattice-ci-kafka-api-key"
  project   = var.gcp_project_id

  replication {
    auto {}
  }

  labels = {
    managed-by = "terraform"
    service    = "confluent"
    component  = "ci-kafka"
  }
}

# Secret for CI Kafka API secret - only create if doesn't exist
resource "google_secret_manager_secret" "ci_kafka_api_secret" {
  count     = local.ci_kafka_api_secret_secret_exists ? 0 : 1
  secret_id = "lattice-ci-kafka-api-secret"
  project   = var.gcp_project_id

  replication {
    auto {}
  }

  labels = {
    managed-by = "terraform"
    service    = "confluent"
    component  = "ci-kafka"
  }
}

locals {
  ci_kafka_api_key_secret_id    = local.ci_kafka_api_key_secret_exists ? data.google_secret_manager_secret.ci_kafka_api_key_existing[0].id : google_secret_manager_secret.ci_kafka_api_key[0].id
  ci_kafka_api_secret_secret_id = local.ci_kafka_api_secret_secret_exists ? data.google_secret_manager_secret.ci_kafka_api_secret_existing[0].id : google_secret_manager_secret.ci_kafka_api_secret[0].id
}

# Always add new version with the current CI Kafka API key value
resource "google_secret_manager_secret_version" "ci_kafka_api_key" {
  secret      = local.ci_kafka_api_key_secret_id
  secret_data = confluent_api_key.ci_kafka.id
}

resource "google_secret_manager_secret_version" "ci_kafka_api_secret" {
  secret      = local.ci_kafka_api_secret_secret_id
  secret_data = confluent_api_key.ci_kafka.secret
}

# -----------------------------------------------------------------------------
# GCP Secret Manager - Worker Kafka Credentials
# -----------------------------------------------------------------------------
# Persists worker Kafka API key to Secret Manager for runtime use.
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

locals {
  worker_kafka_api_key_secret_id    = local.worker_api_key_secret_exists ? data.google_secret_manager_secret.worker_kafka_api_key_existing[0].id : google_secret_manager_secret.worker_kafka_api_key[0].id
  worker_kafka_api_secret_secret_id = local.worker_api_secret_secret_exists ? data.google_secret_manager_secret.worker_kafka_api_secret_existing[0].id : google_secret_manager_secret.worker_kafka_api_secret[0].id
}

# Always add new version with the current worker API key value
resource "google_secret_manager_secret_version" "worker_kafka_api_key" {
  secret      = local.worker_kafka_api_key_secret_id
  secret_data = confluent_api_key.worker.id
}

resource "google_secret_manager_secret_version" "worker_kafka_api_secret" {
  secret      = local.worker_kafka_api_secret_secret_id
  secret_data = confluent_api_key.worker.secret
}
