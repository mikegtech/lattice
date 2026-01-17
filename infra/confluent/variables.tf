variable "gcp_project_id" {
  type = string
}

variable "gcp_region" {
  type    = string
  default = "us-south1"
}

variable "confluent_api_key_secret_name" {
  type        = string
  description = "Secret Manager secret name containing Confluent Cloud API Key"
}

variable "confluent_api_secret_secret_name" {
  type        = string
  description = "Secret Manager secret name containing Confluent Cloud API Secret"
}

variable "confluent_environment_name" {
  type    = string
  default = "lattice"
}

variable "kafka_cluster_name" {
  type    = string
  default = "lattice"
}

variable "kafka_availability" {
  type    = string
  default = "SINGLE_ZONE"
  validation {
    condition     = contains(["SINGLE_ZONE", "MULTI_ZONE"], var.kafka_availability)
    error_message = "kafka_availability must be SINGLE_ZONE or MULTI_ZONE."
  }
}

variable "topics" {
  description = "List of primary topic names (non-DLQ)"
  type        = list(string)
  default = [
    # Mail pipeline
    "lattice.mail.raw.v1",
    "lattice.mail.parse.v1",
    "lattice.mail.chunk.v1",
    "lattice.mail.embed.v1",
    "lattice.mail.upsert.v1",
    "lattice.mail.delete.v1",
    # Attachment pipeline
    "lattice.mail.attachment.v1",
    "lattice.mail.attachment.extracted.v1",
    "lattice.mail.attachment.text.v1",
    # OCR pipeline
    "lattice.ocr.request.v1",
    "lattice.ocr.result.v1",
    # Audit
    "lattice.audit.events.v1",
  ]
}

variable "dlq_topics" {
  description = "List of DLQ topic names (per-topic DLQs for lineage)"
  type        = list(string)
  default = [
    # Mail worker DLQs
    "lattice.dlq.mail.parse.v1",
    "lattice.dlq.mail.chunk.v1",
    "lattice.dlq.mail.embed.v1",
    "lattice.dlq.mail.upsert.v1",
    "lattice.dlq.mail.delete.v1",
    # Attachment worker DLQs
    "lattice.dlq.mail.attachment.v1",
    "lattice.dlq.mail.attachment.chunk.v1",
    "lattice.dlq.mail.ocr.v1",
    # OCR worker DLQ
    "lattice.dlq.ocr.v1",
    # Audit writer DLQ
    "lattice.dlq.audit.events.v1",
  ]
}

variable "primary_partitions" {
  description = "Number of partitions for primary topics"
  type        = number
  default     = 2
}

variable "dlq_partitions" {
  description = "Number of partitions for DLQ topics"
  type        = number
  default     = 1
}

variable "primary_retention_ms" {
  description = "Retention period for primary topics in milliseconds (default: 7 days)"
  type        = number
  default     = 604800000 # 7 days
}

variable "dlq_retention_ms" {
  description = "Retention period for DLQ topics in milliseconds (default: 30 days)"
  type        = number
  default     = 2592000000 # 30 days
}
