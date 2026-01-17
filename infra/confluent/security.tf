# =============================================================================
# Confluent Cloud Service Accounts and Access Control
# =============================================================================
# Service accounts for CI/CD and workers with least-privilege ACLs

# -----------------------------------------------------------------------------
# Service Accounts
# -----------------------------------------------------------------------------

# App Manager service account - used by Terraform to manage topics
resource "confluent_service_account" "app_manager" {
  display_name = "lattice-app-manager"
  description  = "Service account for Terraform topic management"
}

# CI service account - used by GitHub Actions
resource "confluent_service_account" "ci" {
  display_name = "lattice-ci"
  description  = "Service account for CI/CD pipelines"
}

# Worker service account - shared by all workers (can split per-worker if needed)
resource "confluent_service_account" "worker" {
  display_name = "lattice-worker"
  description  = "Service account for Lattice Kafka workers"
}

# -----------------------------------------------------------------------------
# Role Bindings
# -----------------------------------------------------------------------------

# App Manager needs CloudClusterAdmin to manage topics
resource "confluent_role_binding" "app_manager_cluster_admin" {
  principal   = "User:${confluent_service_account.app_manager.id}"
  role_name   = "CloudClusterAdmin"
  crn_pattern = confluent_kafka_cluster.this.rbac_crn
}

# CI account needs CloudClusterAdmin for validation
resource "confluent_role_binding" "ci_cluster_admin" {
  principal   = "User:${confluent_service_account.ci.id}"
  role_name   = "CloudClusterAdmin"
  crn_pattern = confluent_kafka_cluster.this.rbac_crn
}

# Worker needs DeveloperRead and DeveloperWrite on specific resources
# For simplicity, using DeveloperManage at cluster level
# Can be scoped to specific topics if tighter control is needed
resource "confluent_role_binding" "worker_developer" {
  principal   = "User:${confluent_service_account.worker.id}"
  role_name   = "DeveloperManage"
  crn_pattern = confluent_kafka_cluster.this.rbac_crn
}

# -----------------------------------------------------------------------------
# API Keys
# -----------------------------------------------------------------------------

# API key for app manager (Terraform)
resource "confluent_api_key" "app_manager" {
  display_name = "lattice-app-manager-api-key"
  description  = "API key for Terraform topic management"

  owner {
    id          = confluent_service_account.app_manager.id
    api_version = confluent_service_account.app_manager.api_version
    kind        = confluent_service_account.app_manager.kind
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
    confluent_role_binding.app_manager_cluster_admin
  ]
}

# API key for CI (GitHub Actions)
resource "confluent_api_key" "ci" {
  display_name = "lattice-ci-api-key"
  description  = "API key for CI/CD pipelines"

  owner {
    id          = confluent_service_account.ci.id
    api_version = confluent_service_account.ci.api_version
    kind        = confluent_service_account.ci.kind
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
    confluent_role_binding.ci_cluster_admin
  ]
}

# API key for workers
resource "confluent_api_key" "worker" {
  display_name = "lattice-worker-api-key"
  description  = "API key for Lattice workers"

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
    confluent_role_binding.worker_developer
  ]
}
