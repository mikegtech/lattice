terraform {
  required_version = ">= 1.5.0"

  required_providers {
    datadog = {
      source  = "DataDog/datadog"
      version = "~> 3.39"
    }
  }

  # Configure your GCS backend - replace trupryce with your actual GCP project ID
  backend "gcs" {
    bucket = "trupryce-terraform-state" # REPLACE: your-project-id-terraform-state
    prefix = "datadog"
  }
}
