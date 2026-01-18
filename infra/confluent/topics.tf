locals {
  primary_topics = {
    for name in var.topics :
    name => {
      partitions   = var.primary_partitions
      retention_ms = var.primary_retention_ms
    }
  }

  dlq_topics = {
    for name in var.dlq_topics :
    name => {
      partitions   = var.dlq_partitions
      retention_ms = var.dlq_retention_ms
    }
  }

  all_topics = merge(local.primary_topics, local.dlq_topics)
}

resource "confluent_kafka_topic" "topics" {
  for_each = local.all_topics

  kafka_cluster {
    id = local.kafka_cluster_id
  }

  rest_endpoint    = local.kafka_rest_endpoint
  topic_name       = each.key
  partitions_count = each.value.partitions

  config = {
    "retention.ms" = tostring(each.value.retention_ms)
  }

  # Use Terraform-managed CI Kafka API key for topic operations
  # This key is always valid for the current cluster
  credentials {
    key    = confluent_api_key.ci_kafka.id
    secret = confluent_api_key.ci_kafka.secret
  }

  # Ensure CI Kafka service account has cluster admin permissions before creating topics
  depends_on = [
    confluent_role_binding.ci_kafka_cluster_admin
  ]
}
