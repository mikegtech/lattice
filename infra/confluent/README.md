# Confluent Cloud Terraform

Terraform configuration for Lattice Kafka infrastructure on Confluent Cloud (GCP Marketplace).

## Architecture

- **Environment**: `lattice`
- **Cluster**: Basic tier, single-zone (GCP us-south1)
- **Topics**: All Lattice Kafka topics with per-topic DLQs
- **Authentication**: Bootstrap Cloud API key + worker Kafka API key
- **Backend**: GCS bucket for state management

### Identity Model

| Identity | Purpose | How Managed |
|----------|---------|-------------|
| Bootstrap (CI) | Cloud resource management API key | Created manually in Confluent Cloud Console, stored in GitHub Secrets |
| Worker | Kafka API key for workers | Created by Terraform, stored in GCP Secret Manager |

**Design Rationale:**
- ONE bootstrap identity (CI) with Cloud API key for Terraform operations
- Worker identity with Kafka API key scoped to topic-level ACLs
- All secrets created by Terraform are immediately written to GCP Secret Manager

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

### 1. Bootstrap Cloud API Key (Manual Setup)

Create a Cloud resource management API key in Confluent Cloud Console:

1. Go to Confluent Cloud Console → Settings → API Keys
2. Click "Add key" → Select "Granular access"
3. Create or select a service account (e.g., `lattice-ci`)
4. Grant CloudClusterAdmin role on the target cluster
5. Save the key and secret securely

**This key is used by Terraform to manage Confluent resources.**

### 2. GitHub Secrets

Configure these secrets in your GitHub repository settings (under the `confluent-production` environment):

| Secret | Description |
|--------|-------------|
| `GCP_SA_KEY` | GCP service account JSON with GCS + Secret Manager access |
| `GCP_PROJECT_ID` | GCP project ID |
| `CONFLUENT_CLOUD_API_KEY` | Bootstrap Cloud API Key (from step 1) |
| `CONFLUENT_CLOUD_API_SECRET` | Bootstrap Cloud API Secret (from step 1) |
| `DATADOG_API_KEY` | (Optional) For deployment event notifications |

### 3. GitHub Environment

Create a `confluent-production` environment in GitHub repository settings for deployment protection rules.

## Worker Credentials

Worker Kafka API keys are created by Terraform and automatically stored in GCP Secret Manager:

| Secret Name | Description |
|-------------|-------------|
| `lattice-worker-kafka-api-key` | Kafka API key ID |
| `lattice-worker-kafka-api-secret` | Kafka API key secret |

### Retrieving Worker Credentials

```bash
# Get API key
gcloud secrets versions access latest --secret=lattice-worker-kafka-api-key

# Get API secret
gcloud secrets versions access latest --secret=lattice-worker-kafka-api-secret
```

### Worker ACLs

Workers are granted least-privilege access via Kafka ACLs:

| Permission | Resource | Pattern |
|------------|----------|---------|
| READ | Consumer Groups | `lattice-*` (prefixed) |
| READ | Topics | `lattice.*` (prefixed) |
| WRITE | Topics | `lattice.*` (prefixed) |
| WRITE | DLQ Topics | `lattice.dlq.*` (prefixed) |

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
export TF_VAR_gcp_project_id="your-gcp-project"

# Authenticate to GCP (for state backend + Secret Manager)
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

# Apply changes
terraform apply

# View outputs (no secrets exposed)
terraform output
```

**Note:** Never commit Confluent credentials to git. Always use environment variables.

## Importing Existing Resources

If resources were created manually in Confluent Cloud, import them into Terraform state:

### Import Commands

```bash
# Import environment (get ID from Confluent Cloud Console)
terraform import confluent_environment.this env-xxxxx

# Import cluster (get ID from Confluent Cloud Console)
terraform import confluent_kafka_cluster.this lkc-xxxxx

# Import worker service account (get ID from Confluent Cloud Console)
terraform import confluent_service_account.worker sa-xxxxx

# Import topics (run for each topic)
terraform import 'confluent_kafka_topic.topics["lattice.mail.raw.v1"]' lkc-xxxxx/lattice.mail.raw.v1

# Import ACLs (get ACL ID from Confluent Cloud API)
terraform import confluent_kafka_acl.worker_read_topics lkc-xxxxx/TOPIC#lattice.#PREFIXED#User:sa-xxxxx#*#READ#ALLOW
```

### Finding Resource IDs

```bash
# List environments
confluent environment list

# List clusters
confluent kafka cluster list

# List service accounts
confluent iam service-account list

# List topics
confluent kafka topic list --cluster lkc-xxxxx
```

## Key Rotation

### Rotating Worker Kafka API Key

1. **Create new API key** (Terraform will do this on apply if key is deleted):
   ```bash
   # Delete current key version in Secret Manager (optional, keeps history)
   gcloud secrets versions disable latest --secret=lattice-worker-kafka-api-key
   gcloud secrets versions disable latest --secret=lattice-worker-kafka-api-secret

   # Taint the Terraform resource to force recreation
   terraform taint confluent_api_key.worker

   # Apply to create new key and store in Secret Manager
   terraform apply
   ```

2. **Update workers** to use new credentials from Secret Manager

3. **Delete old API key** in Confluent Cloud Console after workers are updated

### Rotating Bootstrap (CI) API Key

1. Create new Cloud API key in Confluent Cloud Console
2. Update GitHub Secrets with new values
3. Delete old API key in Confluent Cloud Console

## Drift Detection

Terraform state may drift if changes are made outside Terraform:

```bash
# Detect drift
terraform plan

# Refresh state from remote
terraform refresh

# If resources were deleted, remove from state
terraform state rm 'confluent_kafka_topic.topics["topic-name"]'
```

## CI/CD Pipeline

The GitHub Actions workflow (`terraform-confluent.yml`) runs:

### On Pull Request
1. Format check (`terraform fmt`)
2. Validate configuration
3. Generate and upload plan artifact

### On Push to Main
1. Apply Terraform changes
2. Worker credentials automatically stored in GCP Secret Manager
3. Send deployment event to Datadog (if enabled)

## Troubleshooting

### Authentication Errors

```bash
# Verify GCP authentication
gcloud auth application-default print-access-token

# Verify Confluent credentials
confluent login --save
confluent environment list
```

### Secret Manager Access

```bash
# Check Secret Manager permissions
gcloud secrets list --project=YOUR_PROJECT_ID

# Verify secret exists
gcloud secrets describe lattice-worker-kafka-api-key --project=YOUR_PROJECT_ID
```

### ACL Issues

```bash
# List ACLs for service account
confluent kafka acl list --cluster lkc-xxxxx --service-account sa-xxxxx
```
