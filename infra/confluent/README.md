# Confluent Cloud Terraform

Terraform configuration for Lattice Kafka infrastructure on Confluent Cloud (GCP Marketplace).

## Architecture

- **Environment**: `lattice`
- **Cluster**: Basic tier, single-zone (GCP us-south1)
- **Topics**: All Lattice Kafka topics with per-topic DLQs
- **Authentication**: All credentials from GCP Secret Manager
- **Backend**: GCS bucket for state management

### Credential Model (Two Planes)

| Plane | Purpose | Secret Manager Keys | Service Account |
|-------|---------|---------------------|-----------------|
| **Control Plane** | Confluent Cloud API (resource management) | `confluent-cloud-api-key`, `confluent-cloud-api-secret` | Cloud resource management |
| **Data Plane** | Kafka operations (topics, ACLs) | `lattice-ci-kafka-api-key`, `lattice-ci-kafka-api-secret` | `lattice-ci-kafka` |
| **Worker** | Runtime Kafka access | `lattice-worker-kafka-api-key`, `lattice-worker-kafka-api-secret` | `lattice-worker` |

**Design Rationale:**
- All credentials stored in GCP Secret Manager (no TF_VAR secrets)
- Control plane key for Confluent provider authentication
- CI Kafka key for topic and ACL management (data plane operations)
- Worker key created by Terraform and persisted to Secret Manager

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

Create these secrets in GCP Secret Manager before running Terraform:

```bash
# Control Plane: Confluent Cloud API credentials
# Get from: Confluent Cloud Console → Settings → API Keys → Cloud resource management
echo -n "YOUR_CLOUD_API_KEY" | gcloud secrets create confluent-cloud-api-key --data-file=-
echo -n "YOUR_CLOUD_API_SECRET" | gcloud secrets create confluent-cloud-api-secret --data-file=-

# Data Plane: CI Kafka API credentials
# Get from: Confluent Cloud Console → Cluster → API Keys → Create for lattice-ci-kafka service account
echo -n "YOUR_CI_KAFKA_KEY" | gcloud secrets create lattice-ci-kafka-api-key --data-file=-
echo -n "YOUR_CI_KAFKA_SECRET" | gcloud secrets create lattice-ci-kafka-api-secret --data-file=-
```

### 2. GitHub Secrets

Configure these secrets in your GitHub repository settings (under the `confluent-production` environment):

| Secret | Description |
|--------|-------------|
| `GCP_SA_KEY` | GCP service account JSON with GCS + Secret Manager access |
| `GCP_PROJECT_ID` | GCP project ID |
| `DATADOG_API_KEY` | (Optional) For deployment event notifications |

**Note:** Confluent credentials are NO longer passed via GitHub Secrets. They are read from GCP Secret Manager.

### 3. GitHub Environment

Create a `confluent-production` environment in GitHub repository settings for deployment protection rules.

## Required Terraform Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `gcp_project_id` | GCP project ID | Yes |
| `confluent_api_key_secret_name` | Secret Manager name for Cloud API key | Yes |
| `confluent_api_secret_secret_name` | Secret Manager name for Cloud API secret | Yes |
| `ci_kafka_api_key_secret_name` | Secret Manager name for CI Kafka key | No (default: `lattice-ci-kafka-api-key`) |
| `ci_kafka_api_secret_secret_name` | Secret Manager name for CI Kafka secret | No (default: `lattice-ci-kafka-api-secret`) |

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
# Edit terraform.tfvars with your Secret Manager secret names

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

### Rotating Worker Kafka API Key

1. **Create new API key** (Terraform will do this on apply if key is deleted):
   ```bash
   # Taint the Terraform resource to force recreation
   terraform taint confluent_api_key.worker

   # Apply to create new key and store in Secret Manager
   terraform apply
   ```

2. **Update workers** to use new credentials from Secret Manager

3. **Delete old API key** in Confluent Cloud Console after workers are updated

### Rotating CI Kafka API Key

1. Create new Kafka API key in Confluent Cloud Console for `lattice-ci-kafka` service account
2. Update GCP Secret Manager:
   ```bash
   echo -n "NEW_KEY" | gcloud secrets versions add lattice-ci-kafka-api-key --data-file=-
   echo -n "NEW_SECRET" | gcloud secrets versions add lattice-ci-kafka-api-secret --data-file=-
   ```
3. Re-run `terraform apply` to use new credentials
4. Delete old API key in Confluent Cloud Console

### Rotating Control Plane API Key

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
2. Worker credentials automatically stored in GCP Secret Manager
3. Send deployment event to Datadog (if enabled)

## Troubleshooting

### Authentication Errors

```bash
# Verify GCP authentication
gcloud auth application-default print-access-token

# Verify Secret Manager access
gcloud secrets versions access latest --secret=confluent-cloud-api-key

# Verify Confluent CLI access
confluent login --save
confluent environment list
```

### Secret Manager Access

```bash
# Check Secret Manager permissions
gcloud secrets list --project=YOUR_PROJECT_ID

# Verify all required secrets exist
for secret in confluent-cloud-api-key confluent-cloud-api-secret \
              lattice-ci-kafka-api-key lattice-ci-kafka-api-secret; do
  gcloud secrets describe $secret --project=YOUR_PROJECT_ID
done
```

### ACL Issues

```bash
# List ACLs for service account
confluent kafka acl list --cluster lkc-xxxxx --service-account sa-xxxxx
```
