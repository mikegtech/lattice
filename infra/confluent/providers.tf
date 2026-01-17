provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

data "google_secret_manager_secret_version" "confluent_cloud_api_key" {
  secret  = var.confluent_api_key_secret_name
  project = var.gcp_project_id
}

data "google_secret_manager_secret_version" "confluent_cloud_api_secret" {
  secret  = var.confluent_api_secret_secret_name
  project = var.gcp_project_id
}

provider "confluent" {
  cloud_api_key    = data.google_secret_manager_secret_version.confluent_cloud_api_key.secret_data
  cloud_api_secret = data.google_secret_manager_secret_version.confluent_cloud_api_secret.secret_data
}
