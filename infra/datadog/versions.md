terraform {
  required_version = ">= 1.5.0"

  required_providers {
    datadog = {
      source  = "DataDog/datadog"
      version = "~> 3.39"
    }
  }

  backend "gcs" {
    bucket = "trupryce-terraform-state"  # Replace with your bucket name
    prefix = "datadog"                           # Creates datadog/default.tfstate
  }
}
```

---

## GitHub Actions Workflow Name

For the workflow file, I recommend:

| File Name | Why |
|-----------|-----|
| `.github/workflows/terraform-datadog.yml` | Clear, follows `terraform-{target}` convention |

If you later add more Terraform-managed infrastructure, you'd have:
- `.github/workflows/terraform-datadog.yml`
- `.github/workflows/terraform-gcp.yml`
- `.github/workflows/terraform-k8s.yml`

---

## Complete Directory Structure
```
your-repo/
├── .github/
│   └── workflows/
│       └── terraform-datadog.yml      # GitHub Actions workflow
├── infra/
│   └── datadog/
│       ├── main.tf                    # Provider config, locals
│       ├── variables.tf               # Input variables
│       ├── versions.tf                # Terraform + provider versions + backend
│       ├── outputs.tf                 # Output values
│       ├── pipelines.tf               # Log pipelines
│       ├── monitor_dlq.tf             # DLQ monitors
│       ├── monitor_errors.tf          # Error rate monitors
│       ├── monitor_availability.tf    # Availability monitors
│       ├── monitor_kafka.tf           # Kafka monitors
│       ├── monitor_latency.tf         # Latency monitors
│       ├── dashboard.tf               # Dashboard definition
│       └── README.md                  # Setup documentation
