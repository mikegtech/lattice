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

  # Use CI Kafka API key (data plane) for topic management
  # This key is owned by lattice-ci-kafka service account
  credentials {
    key    = data.google_secret_manager_secret_version.ci_kafka_api_key.secret_data
    secret = data.google_secret_manager_secret_version.ci_kafka_api_secret.secret_data
  }
}
