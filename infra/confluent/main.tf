resource "confluent_environment" "this" {
  display_name = var.confluent_environment_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "confluent_kafka_cluster" "this" {
  display_name = var.kafka_cluster_name
  availability = var.kafka_availability
  cloud        = "GCP"
  region       = var.gcp_region

  basic {}
  environment {
    id = confluent_environment.this.id
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      environment, # Prevent recreation if environment reference drifts
    ]
  }
}
