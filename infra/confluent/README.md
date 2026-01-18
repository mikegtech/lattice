# Confluent Cloud Terraform

Terraform configuration for Lattice Kafka infrastructure on Confluent Cloud (GCP Marketplace).

## Architecture

- **Environment**: `lattice`
- **Cluster**: Basic tier, single-zone (GCP us-south1)
- **Topics**: All Lattice Kafka topics with per-topic DLQs
- **Authentication**: Terraform-managed API keys persisted to GCP Secret Manager
- **Backend**: GCS bucket for state management

### Credential Model (Two Planes)

| Plane | Purpose | Service Account | Management |
|-------|---------|-----------------|------------|
| **Control Plane** | Confluent Cloud API (resource management) | Cloud resource management | Manual - stored in Secret Manager |
| **CI Kafka** | Terraform Kafka operations (topics, ACLs) | `lattice-ci-kafka` | **Terraform-managed** |
| **Worker** | Runtime Kafka access | `lattice-worker` | **Terraform-managed** |

**Design Rationale:**
- Control plane key: Manually created, stored in Secret Manager, used by Confluent provider
- CI Kafka key: Terraform-managed, always valid for current cluster, used for topic/ACL creation
- Worker key: Terraform-managed, persisted to Secret Manager for runtime use

## Terraform-Managed Credentials

Terraform creates and manages these API keys automatically. They are persisted to GCP Secret Manager:

| Secret Name | Description | Service Account |
|-------------|-------------|-----------------|
| `lattice-ci-kafka-api-key` | CI Kafka API key ID | `lattice-ci-kafka` |
| `lattice-ci-kafka-api-secret` | CI Kafka API key secret | `lattice-ci-kafka` |
| `lattice-worker-kafka-api-key` | Worker Kafka API key ID | `lattice-worker` |
| `lattice-worker-kafka-api-secret` | Worker Kafka API key secret | `lattice-worker` |

**Key Benefits:**
- CI Kafka key is always valid for the current cluster (never 401 errors after cluster changes)
- No manual key creation required for CI/CD
- Automatic rotation via workflow dispatch input

### Retrieving Credentials

```bash
# CI Kafka API key (for debugging, normally used only by Terraform)
gcloud secrets versions access latest --secret=lattice-ci-kafka-api-key
gcloud secrets versions access latest --secret=lattice-ci-kafka-api-secret

# Worker API key (for application configuration)
gcloud secrets versions access latest --secret=lattice-worker-kafka-api-key
gcloud secrets versions access latest --secret=lattice-worker-kafka-api-secret
```

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

### 1. GCP Secret Manager Setup

Create **only** the Control Plane secrets in GCP Secret Manager before running Terraform:

```bash
# Control Plane: Confluent Cloud API credentials (ONLY manual secrets required)
# Get from: Confluent Cloud Console → Settings → API Keys → Cloud resource management
echo -n "YOUR_CLOUD_API_KEY" | gcloud secrets create confluent-cloud-api-key --data-file=-
echo -n "YOUR_CLOUD_API_SECRET" | gcloud secrets create confluent-cloud-api-secret --data-file=-
```

**Note:** CI Kafka and Worker credentials are created automatically by Terraform. No manual key creation needed.

### 2. GitHub Secrets

Configure these secrets in your GitHub repository settings (under the `confluent-production` environment):

| Secret | Description |
|--------|-------------|
| `GCP_SA_KEY` | GCP service account JSON with GCS + Secret Manager access |
| `GCP_PROJECT_ID` | GCP project ID |
| `DATADOG_API_KEY` | (Optional) For deployment event notifications |

**Note:** Confluent credentials are NOT passed via GitHub Secrets. Control plane credentials are read from GCP Secret Manager; CI Kafka and Worker keys are Terraform-managed.

### 3. GitHub Environment Variables

Configure these optional environment variables in the `confluent-production` environment:

| Variable | Description |
|----------|-------------|
| `EXISTING_ENVIRONMENT_ID` | Existing Confluent environment ID (e.g., `env-xxxxx`) |
| `EXISTING_CLUSTER_ID` | Existing Kafka cluster ID (e.g., `lkc-xxxxx`) |
| `EXISTING_SERVICE_ACCOUNT_ID` | Existing worker service account ID (e.g., `sa-xxxxx`) |
| `DATADOG_EVENTS_ENABLED` | Set to `true` to enable Datadog events |

### 4. GitHub Environment

Create a `confluent-production` environment in GitHub repository settings for deployment protection rules.

## Required Terraform Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `gcp_project_id` | GCP project ID | Yes |
| `confluent_api_key_secret_name` | Secret Manager name for Cloud API key | Yes |
| `confluent_api_secret_secret_name` | Secret Manager name for Cloud API secret | Yes |

## Worker ACLs

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
# Edit terraform.tfvars with your project ID and secret names

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

### Rotating CI Kafka API Key (Terraform-Managed)

Use the workflow dispatch input or Terraform variable:

```bash
# Via GitHub Actions (recommended)
# Go to Actions → Terraform Confluent → Run workflow
# Check "Force rotation of CI Kafka API key"

# Via Terraform locally
terraform apply -var="rotate_ci_kafka_api_key=true"

# Reset after rotation
terraform apply -var="rotate_ci_kafka_api_key=false"
```

### Rotating Worker Kafka API Key (Terraform-Managed)

```bash
# Via GitHub Actions (recommended)
# Go to Actions → Terraform Confluent → Run workflow
# Check "Force rotation of worker Kafka API key"

# Via Terraform locally
terraform apply -var="rotate_worker_api_key=true"

# Reset after rotation
terraform apply -var="rotate_worker_api_key=false"

# Update workers to use new credentials from Secret Manager
```

### Rotating Control Plane API Key (Manual)

1. Create new Cloud API key in Confluent Cloud Console
2. Update GCP Secret Manager:
   ```bash
   echo -n "NEW_KEY" | gcloud secrets versions add confluent-cloud-api-key --data-file=-
   echo -n "NEW_SECRET" | gcloud secrets versions add confluent-cloud-api-secret --data-file=-
   ```
3. Re-run `terraform apply` to verify
4. Delete old API key in Confluent Cloud Console

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

## Lifecycle Protection

The environment and cluster have `prevent_destroy = true` to prevent accidental deletion.

If you need to destroy these resources intentionally:

1. Temporarily remove the lifecycle block from `main.tf`
2. Run `terraform apply` to update state
3. Run `terraform destroy` for the specific resource
4. **Restore the lifecycle block immediately after**

```bash
# To destroy a protected resource (USE WITH CAUTION):
# 1. Edit main.tf to remove lifecycle { prevent_destroy = true }
# 2. Apply the change
terraform apply

# 3. Destroy the specific resource
terraform destroy -target=confluent_kafka_cluster.this

# 4. Re-add the lifecycle block and apply
```

**Warning:** Destroying the cluster will delete all topics and data. This is irreversible.

## CI/CD Pipeline

The GitHub Actions workflow (`terraform-confluent.yml`) runs:

### On Pull Request
1. Format check (`terraform fmt`)
2. Validate configuration
3. Generate and upload plan artifact

### On Push to Main
1. Apply Terraform changes
2. CI Kafka and Worker credentials automatically stored in GCP Secret Manager
3. Send deployment event to Datadog (if enabled)

### Workflow Dispatch Inputs

| Input | Description |
|-------|-------------|
| `existing_environment_id` | Use existing environment instead of creating new |
| `existing_cluster_id` | Use existing cluster instead of creating new |
| `existing_service_account_id` | Use existing worker service account instead of creating new |
| `rotate_ci_kafka_api_key` | Force rotation of CI Kafka API key |
| `rotate_worker_api_key` | Force rotation of worker Kafka API key |

## Troubleshooting

### Authentication Errors

```bash
# Verify GCP authentication
gcloud auth application-default print-access-token

# Verify Secret Manager access (Control Plane credentials)
gcloud secrets versions access latest --secret=confluent-cloud-api-key

# Verify Confluent CLI access
confluent login --save
confluent environment list
```

### Secret Manager Access

```bash
# Check Secret Manager permissions
gcloud secrets list --project=YOUR_PROJECT_ID

# Verify control plane secrets exist (only manual secrets required)
for secret in confluent-cloud-api-key confluent-cloud-api-secret; do
  gcloud secrets describe $secret --project=YOUR_PROJECT_ID
done
```

### ACL Issues

```bash
# List ACLs for service account
confluent kafka acl list --cluster lkc-xxxxx --service-account sa-xxxxx
```

### 401 Unauthorized Errors

If you see 401 errors during topic or ACL creation:
- This should not happen with Terraform-managed CI Kafka keys
- Verify the Confluent Cloud API credentials are correct
- Check if the cluster ID has changed (run `terraform plan` to see)
