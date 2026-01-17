provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

# Confluent credentials passed directly from GitHub Secrets via TF_VAR_*
# This matches the datadog workflow pattern and avoids Secret Manager dependency
provider "confluent" {
  cloud_api_key    = var.confluent_cloud_api_key
  cloud_api_secret = var.confluent_cloud_api_secret
}
