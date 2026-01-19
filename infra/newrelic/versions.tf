terraform {
  required_version = ">= 1.5.0"

  required_providers {
    newrelic = {
      source  = "newrelic/newrelic"
      version = "~> 3.35"
    }
  }

  backend "gcs" {
    bucket = "trupryce-terraform-state"
    prefix = "newrelic"
  }
}
