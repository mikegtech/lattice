# Confluent Cloud Terraform

Terraform configuration for Lattice Kafka infrastructure on Confluent Cloud (GCP Marketplace).

## Architecture

- **Environment**: `lattice`
- **Cluster**: Basic tier, single-zone (GCP us-east1)
- **Topics**: All Lattice Kafka topics with per-topic DLQs
- **Service Accounts**: Separate accounts for app-manager, CI, and workers
- **Backend**: GCS bucket for state management

## Topics

### Primary Topics (2 partitions, 7-day retention)

| Topic | Description |
|-------|-------------|
| `lattice.mail.raw.v1` | Raw email events from connectors |
| `lattice.mail.parse.v1` | Parsed email content |
| `lattice.mail.chunk.v1` | Chunked text for embedding |
| `lattice.mail.embed.v1` | Embedding results |
| `lattice.mail.upsert.v1` | Vector upsert confirmations |
| `lattice.mail.delete.v1` | Deletion requests |
| `lattice.mail.attachment.v1` | Attachment extraction requests |
| `lattice.mail.attachment.extracted.v1` | Extracted attachment content |
| `lattice.mail.attachment.text.v1` | Attachment text (from extraction or OCR) |
| `lattice.ocr.request.v1` | OCR processing requests |
| `lattice.ocr.result.v1` | OCR processing results |
| `lattice.audit.events.v1` | Audit trail events |

### DLQ Topics (1 partition, 30-day retention)

| Topic | Worker |
|-------|--------|
| `lattice.dlq.mail.parse.v1` | mail-parser |
| `lattice.dlq.mail.chunk.v1` | mail-chunker |
| `lattice.dlq.mail.embed.v1` | mail-embedder |
| `lattice.dlq.mail.upsert.v1` | mail-upserter |
| `lattice.dlq.mail.delete.v1` | mail-deleter |
| `lattice.dlq.mail.attachment.v1` | mail-extractor |
| `lattice.dlq.mail.attachment.chunk.v1` | attachment-chunker |
| `lattice.dlq.mail.ocr.v1` | mail-ocr-normalizer |
| `lattice.dlq.ocr.v1` | ocr-worker |
| `lattice.dlq.audit.events.v1` | audit-writer |

## Prerequisites

### Confluent Cloud API Keys

Create API keys in the Confluent Cloud Console:
1. Go to Confluent Cloud Console → API Keys
2. Create a Cloud API key (not a Kafka API key)
3. Save the key and secret securely

### GitHub Secrets

Configure these secrets in your GitHub repository settings (under the `confluent-production` environment):

| Secret | Description |
|--------|-------------|
| `GCP_SA_KEY` | GCP service account JSON key with GCS access for state backend |
| `CONFLUENT_CLOUD_API_KEY` | Confluent Cloud API Key (from Confluent Cloud Console) |
| `CONFLUENT_CLOUD_API_SECRET` | Confluent Cloud API Secret (from Confluent Cloud Console) |
| `DATADOG_API_KEY` | (Optional) For deployment event notifications |

### GitHub Environment

Create a `confluent-production` environment in GitHub repository settings for deployment protection rules.

## Local Development

### Initial Setup

```bash
cd infra/confluent

# Copy and configure variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# Set Confluent credentials as environment variables
export TF_VAR_confluent_cloud_api_key="your-api-key"  # pragma: allowlist secret
export TF_VAR_confluent_cloud_api_secret="your-api-secret"  # pragma: allowlist secret

# Authenticate to GCP (for state backend)
gcloud auth application-default login

# Initialize Terraform
terraform init
```

### Running Terraform

```bash
# Validate configuration
terraform validate

# Preview changes
terraform plan

# Apply changes (requires approval for production)
terraform apply

# View outputs
terraform output
terraform output -raw api_key_worker_secret  # Sensitive value
```

**Note:** Never commit Confluent credentials to git. Always use environment variables or a secrets manager.

### Importing Existing Resources

If the Confluent environment or cluster already exists:

```bash
# Import environment
terraform import confluent_environment.this env-xxxxx

# Import cluster
terraform import confluent_kafka_cluster.this lkc-xxxxx
```

## CI/CD Pipeline

The GitHub Actions workflow (`terraform-confluent.yml`) runs:

### On Pull Request
1. Format check (`terraform fmt`)
2. Validate configuration
3. Generate and upload plan artifact

### On Push to Main
1. Apply Terraform changes
2. Send deployment event to Datadog (if enabled)

## Service Accounts

| Account | Purpose | Permissions |
|---------|---------|-------------|
| `lattice-app-manager` | Terraform topic management | CloudClusterAdmin |
| `lattice-ci` | CI/CD validation | CloudClusterAdmin |
| `lattice-worker` | Worker Kafka access | DeveloperManage |

## Troubleshooting

### Authentication Errors

```bash
# Verify GCP authentication
gcloud auth application-default print-access-token

# Check Secret Manager access
gcloud secrets versions access latest --secret=confluent-cloud-api-key
```

### State Issues

```bash
# List state resources
terraform state list

# Refresh state from remote
terraform refresh
```

### Topic Creation Failures

Ensure the app-manager service account has CloudClusterAdmin role binding before creating topics. The `depends_on` in topics.tf handles this for initial apply.
