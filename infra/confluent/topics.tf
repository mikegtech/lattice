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
    id = confluent_kafka_cluster.this.id
  }

  topic_name       = each.key
  partitions_count = each.value.partitions

  config = {
    "retention.ms" = tostring(each.value.retention_ms)
  }

  # Required credentials for topic management on Basic cluster
  credentials {
    key    = confluent_api_key.app_manager.id
    secret = confluent_api_key.app_manager.secret
  }

  depends_on = [
    confluent_role_binding.app_manager_cluster_admin
  ]
}
