# Datadog Infrastructure

Terraform configuration for Lattice observability infrastructure in Datadog.

## What's Managed

This Terraform configuration creates and manages:

### Log Pipeline
- **Lattice Worker Logs Pipeline**: Parses and enriches logs from all Lattice workers
  - Status remapping for log levels
  - Event name extraction for filtering
  - Log tier categorization (critical, operational, lifecycle, debug)
  - Duration and error code extraction

### Log-Based Metrics
- `lattice.processing.duration_ms`: Distribution of processing times
- `lattice.dlq.count`: DLQ message counts by error code
- `lattice.messages.processed`: Message throughput by stage
- `lattice.errors.count`: Error counts by service and code

### Monitors (Detection Rules)

| Monitor | Severity | Trigger |
|---------|----------|---------|
| DLQ Spike | High | >10 DLQ messages in 5 min |
| DLQ Schema Errors | High | >5 schema validation failures in 15 min |
| DLQ Critical Volume | Critical | >100 DLQ messages in 10 min |
| High Error Rate | Medium | >50 errors in 5 min per service |
| Sustained Errors | Medium | >100 errors in 30 min per service |
| Error Spike | High | >30 errors in 5 min total |
| No Logs from Worker | Critical | No logs for 10 min |
| Worker Shutdown | Info | Shutdown event detected |
| Multiple Restarts | High | >3 restarts in 30 min |
| Kafka Connection Error | High | >3 connection errors in 5 min |
| Kafka Consumer Timeout | High | >5 timeouts in 5 min |
| All Workers Disconnected | Critical | No Kafka connections for 15 min |
| High Processing Latency | Medium | Avg >5s processing time |
| Throughput Drop | Medium | <10 messages processed in 15 min |

### Dashboard
- **Lattice Worker Health**: Comprehensive observability dashboard
  - Service health overview (errors, DLQ, processed counts)
  - Pipeline throughput by stage
  - Error analysis and top error codes
  - Infrastructure/connectivity monitoring

## Prerequisites

### 1. GCP Setup
Create a GCS bucket for Terraform state:
```bash
export PROJECT_ID="your-gcp-project-id"
gsutil mb -p $PROJECT_ID -l us-central1 -b on gs://${PROJECT_ID}-terraform-state
gsutil versioning set on gs://${PROJECT_ID}-terraform-state
```

Create a service account for GitHub Actions:
```bash
gcloud iam service-accounts create github-actions-terraform \
  --display-name="GitHub Actions Terraform"

export SA_EMAIL="github-actions-terraform@${PROJECT_ID}.iam.gserviceaccount.com"

gsutil iam ch serviceAccount:${SA_EMAIL}:objectAdmin gs://${PROJECT_ID}-terraform-state

gcloud iam service-accounts keys create ~/github-actions-terraform-key.json \
  --iam-account=$SA_EMAIL
```

### 2. Datadog Setup
1. Go to **Organization Settings → API Keys** and create an API key
2. Go to **Organization Settings → Application Keys** and create an application key
3. (Optional) Configure Slack integration in **Integrations → Slack**

### 3. GitHub Setup

Create environment `datadog-production`:
```
GitHub Repo → Settings → Environments → New environment
Name: datadog-production
```

Add environment secrets:
- `DATADOG_API_KEY`: Your Datadog API key
- `DATADOG_APP_KEY`: Your Datadog Application key

Add repository secret:
- `GCP_SA_KEY`: Content of the service account JSON key file

### 4. Update Configuration
Edit `versions.tf` and replace `YOUR_PROJECT_ID` with your actual GCP project ID:
```hcl
backend "gcs" {
  bucket = "your-project-id-terraform-state"
  prefix = "datadog"
}
```

## Local Development

### Initialize
```bash
cd infra/datadog
terraform init
```

### Plan
```bash
export TF_VAR_datadog_api_key=""
export TF_VAR_datadog_app_key=""
terraform plan
```

### Apply (with caution)
```bash
terraform apply
```

## CI/CD

The GitHub Actions workflow (`.github/workflows/terraform-datadog.yml`) runs automatically:

- **On PR to main**: Runs `terraform plan` and comments the output on the PR
- **On merge to main**: Runs `terraform apply` and sends deployment events to Datadog

All notifications flow through Datadog (no direct Slack webhooks required).

## Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `datadog_api_key` | Datadog API Key (sensitive) | Required |
| `datadog_app_key` | Datadog Application Key (sensitive) | Required |
| `datadog_api_url` | Datadog API URL | `https://api.datadoghq.com` |
| `environment` | Environment name | `production` |
| `team` | Team name for tagging | `platform` |
| `slack_channel` | Slack channel for alerts | `#lattice-alerts` |
| `pagerduty_service` | PagerDuty service (optional) | `""` |

## Outputs

| Output | Description |
|--------|-------------|
| `pipeline_id` | ID of the log pipeline |
| `pipeline_name` | Name of the log pipeline |
| `dashboard_url` | Direct URL to the dashboard |
| `monitor_ids` | Map of monitor names to IDs |

## Customization

### Adding a New Monitor
1. Create a new `monitor_*.tf` file or add to existing one
2. Use `datadog_monitor` resource
3. Reference `local.common_tags` for consistent tagging
4. Use `local.notify_slack_alerts` for notifications

### Adding a New Service
Edit `main.tf` and add to `local.lattice_services`:
```hcl
lattice_services = [
  "lattice-worker-mail-parser",
  # ... existing services
  "lattice-worker-new-service",  # Add here
]
```

### Adjusting Thresholds
Edit the relevant monitor file and update `monitor_thresholds`:
```hcl
monitor_thresholds {
  critical = 10   # Adjust as needed
  warning  = 5
}
```

## Troubleshooting

### Terraform State Lock
If you get a state lock error:
```bash
terraform force-unlock LOCK_ID
```

### Dashboard Not Showing Data
1. Verify logs are flowing: Check Datadog Logs with `service:lattice-worker-*`
2. Check pipeline is enabled: Logs → Configuration → Pipelines
3. Verify event names match: `@event:lattice.*`

### Monitors Not Triggering
1. Check log query in Datadog Logs Explorer
2. Verify time window matches expected data
3. Check monitor is enabled in Monitors list
