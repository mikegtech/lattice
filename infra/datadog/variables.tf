variable "datadog_api_key" {
  description = "Datadog API Key"
  type        = string
  sensitive   = true
}

variable "datadog_app_key" {
  description = "Datadog Application Key"
  type        = string
  sensitive   = true
}

variable "datadog_api_url" {
  description = "Datadog API URL (use https://api.datadoghq.eu for EU)"
  type        = string
  default     = "https://api.us5.datadoghq.com"
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

variable "slack_channel" {
  description = "Slack channel for Datadog notifications (e.g., #lattice-alerts)"
  type        = string
  default     = "#lattice-alerts"
}

variable "pagerduty_service" {
  description = "PagerDuty service name for critical alerts (leave empty to skip PD)"
  type        = string
  default     = ""
}
