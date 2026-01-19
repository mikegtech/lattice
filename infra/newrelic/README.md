# New Relic Terraform for Lattice

This directory contains Terraform configuration to set up New Relic monitoring for Lattice workers.

## Prerequisites

1. New Relic account with API access
2. Terraform >= 1.5.0
3. GCS bucket for Terraform state (or update backend configuration)

## Setup

1. Copy the example tfvars file:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   ```

2. Fill in your New Relic credentials:
   - `newrelic_account_id`: Your New Relic account ID
   - `newrelic_api_key`: User API key (starts with `NRAK-`)
   - `newrelic_region`: `US` or `EU`

3. Initialize Terraform:
   ```bash
   terraform init
   ```

4. Plan and apply:
   ```bash
   terraform plan
   terraform apply
   ```

## Resources Created

### Alert Policy
- **Lattice Worker Alerts**: Groups all worker-related alerts

### Alert Conditions

| Category | Alert | Threshold |
|----------|-------|-----------|
| Errors | High Error Rate | > 50 errors / 5m (critical), > 20 (warning) |
| Errors | Sustained Errors | > 100 errors / 30m |
| Errors | Error Spike | Anomaly detection (3σ above baseline) |
| DLQ | DLQ Spike | > 10 DLQ messages / 5m |
| DLQ | Schema Errors | > 5 schema errors / 10m |
| Availability | Worker No Logs | < 1 log / 10m |
| Availability | Worker Shutdown | Any shutdown detected |
| Availability | Multiple Restarts | > 5 restarts / 30m |
| Kafka | Connection Errors | > 5 errors / 5m |
| Kafka | Consumer Timeout | > 3 timeouts / 5m |
| Latency | High Processing Latency | P95 > 30s (critical), > 10s (warning) |
| Latency | High Embedding Latency | P95 > 60s (critical), > 30s (warning) |

### Dashboard
- **Lattice Worker Health**: Three-page dashboard with:
  - Overview (billboards, error rates, throughput)
  - Kafka & Processing (timeseries, latency histograms)
  - Logs (volume by level, recent errors table)

## Notifications

Configure optional notification channels:
- **Slack**: Set `slack_channel_url` to your webhook URL
- **PagerDuty**: Set `pagerduty_service_key` for critical alerts

## Migration from Datadog

This module provides equivalent functionality to `infra/datadog/`:

| Datadog | New Relic |
|---------|-----------|
| `datadog_monitor` | `newrelic_nrql_alert_condition` |
| `datadog_dashboard` | `newrelic_one_dashboard` |
| Log Pipelines | Log Parsing Rules (via NerdGraph) |
| DogStatsD metrics | `newrelic.recordMetric()` API |
