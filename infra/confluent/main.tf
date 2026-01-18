# =============================================================================
# Confluent Environment and Kafka Cluster
# =============================================================================
# Uses "Lookup First" pattern:
# - If existing_*_id is provided, use data source to look up
# - If empty, create new resource
# - Locals provide consistent reference regardless of source
# =============================================================================

# -----------------------------------------------------------------------------
# Environment
# -----------------------------------------------------------------------------

# Lookup existing environment if ID provided
data "confluent_environment" "existing" {
  count = var.existing_environment_id != "" ? 1 : 0
  id    = var.existing_environment_id
}

# Create new environment if no existing ID
resource "confluent_environment" "this" {
  count        = var.existing_environment_id == "" ? 1 : 0
  display_name = var.confluent_environment_name

  lifecycle {
    prevent_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Kafka Cluster
# -----------------------------------------------------------------------------

# Lookup existing cluster if ID provided
data "confluent_kafka_cluster" "existing" {
  count = var.existing_cluster_id != "" ? 1 : 0
  id    = var.existing_cluster_id

  environment {
    id = local.environment_id
  }
}

# Create new cluster if no existing ID
resource "confluent_kafka_cluster" "this" {
  count        = var.existing_cluster_id == "" ? 1 : 0
  display_name = var.kafka_cluster_name
  availability = var.kafka_availability
  cloud        = "GCP"
  region       = var.gcp_region

  basic {}

  environment {
    id = local.environment_id
  }

  lifecycle {
    prevent_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Locals - Single Source of Truth
# -----------------------------------------------------------------------------
# Use these locals throughout other files to reference environment/cluster
# regardless of whether they were created or looked up.
# -----------------------------------------------------------------------------

locals {
  # Environment
  use_existing_environment = var.existing_environment_id != ""
  environment_id           = local.use_existing_environment ? data.confluent_environment.existing[0].id : confluent_environment.this[0].id

  # Cluster
  use_existing_cluster     = var.existing_cluster_id != ""
  kafka_cluster_id         = local.use_existing_cluster ? data.confluent_kafka_cluster.existing[0].id : confluent_kafka_cluster.this[0].id
  kafka_rest_endpoint      = local.use_existing_cluster ? data.confluent_kafka_cluster.existing[0].rest_endpoint : confluent_kafka_cluster.this[0].rest_endpoint
  kafka_bootstrap_endpoint = local.use_existing_cluster ? data.confluent_kafka_cluster.existing[0].bootstrap_endpoint : confluent_kafka_cluster.this[0].bootstrap_endpoint
}
