variable "newrelic_account_id" {
  description = "New Relic Account ID"
  type        = number
}

variable "newrelic_api_key" {
  description = "New Relic User API Key (for NerdGraph)"
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

# =============================================================================
# Native Slack Integration
# Set up in New Relic UI first: Alerts → Destinations → Add destination → Slack
# =============================================================================

variable "slack_channel_id" {
  description = "Slack channel ID for notifications (e.g., C0123456789). Find in Slack channel settings."
  type        = string
  default     = ""
}

variable "slack_team_id" {
  description = "Slack workspace/team ID (e.g., T0123456789). Find in Slack workspace settings."
  type        = string
  default     = ""
}

variable "slack_oauth_token" {
  description = "Slack OAuth token from New Relic Slack app installation"
  type        = string
  default     = ""
  sensitive   = true
}

variable "pagerduty_service_key" {
  description = "PagerDuty service integration key for critical alerts (leave empty to skip)"
  type        = string
  default     = ""
  sensitive   = true
}
