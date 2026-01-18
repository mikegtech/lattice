variable "gcp_project_id" {
  type        = string
  description = "GCP project ID (required for state backend and Secret Manager)"
}

variable "gcp_region" {
  type    = string
  default = "us-south1"
}

# -----------------------------------------------------------------------------
# Control Plane Credentials (Confluent Cloud API)
# -----------------------------------------------------------------------------
# These are the ONLY secrets that must be manually created in Secret Manager.
# They provide Cloud API access for the Confluent provider to manage resources.
# -----------------------------------------------------------------------------

variable "confluent_api_key_secret_name" {
  type        = string
  description = "Secret Manager secret name for Confluent Cloud API key (control plane)"
}

variable "confluent_api_secret_secret_name" {
  type        = string
  description = "Secret Manager secret name for Confluent Cloud API secret (control plane)"
}

# -----------------------------------------------------------------------------
# Confluent Cloud Configuration
# -----------------------------------------------------------------------------

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

# -----------------------------------------------------------------------------
# Topic Configuration
# -----------------------------------------------------------------------------

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

# -----------------------------------------------------------------------------
# Existing Resource IDs (Lookup Pattern)
# -----------------------------------------------------------------------------
# Set these to use existing resources instead of creating new ones.
# Leave empty ("") to create new resources.
# -----------------------------------------------------------------------------

variable "existing_environment_id" {
  description = "Existing Confluent environment ID (e.g., env-xxxxx). Leave empty to create new."
  type        = string
  default     = ""
}

variable "existing_cluster_id" {
  description = "Existing Kafka cluster ID (e.g., lkc-xxxxx). Leave empty to create new."
  type        = string
  default     = ""
}

variable "existing_service_account_id" {
  description = "Existing worker service account ID (e.g., sa-xxxxx). Leave empty to create new."
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# API Key Rotation
# -----------------------------------------------------------------------------
# Set to true to force rotation, then reset to false after apply.
# -----------------------------------------------------------------------------

variable "rotate_ci_kafka_api_key" {
  description = "Set to true to force rotation of the CI Kafka API key. Reset to false after rotation."
  type        = bool
  default     = false
}

variable "rotate_worker_api_key" {
  description = "Set to true to force rotation of the worker Kafka API key. Reset to false after rotation."
  type        = bool
  default     = false
}
