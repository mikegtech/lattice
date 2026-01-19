variable "newrelic_account_id" {
  description = "New Relic Account ID"
  type        = number
}

variable "newrelic_api_key" {
  description = "New Relic User API Key (starts with NRAK-). Get from: New Relic → User menu → API Keys → Create key → User type"
  type        = string
  sensitive   = true
}

variable "newrelic_region" {
  description = "New Relic region: US or EU"
  type        = string
  default     = "US"

  validation {
    condition     = contains(["US", "EU"], var.newrelic_region)
    error_message = "Region must be US or EU."
  }
}

variable "environment" {
  description = "Environment name for tagging"
  type        = string
  default     = "production"
}

variable "team" {
  description = "Team name for tagging"
  type        = string
  default     = "platform"
}

variable "pagerduty_service_key" {
  description = "PagerDuty service integration key for critical alerts (leave empty to skip)"
  type        = string
  default     = ""
  sensitive   = true
}
