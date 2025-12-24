# Demo: Two-Inbox Mail Ingestion with Airflow

This runbook demonstrates Phase 2 multi-provider mail ingestion using Airflow DAGs to orchestrate Gmail and WorkMail IMAP processing.

## Overview

The demo shows:
1. Seeding two mail accounts in Postgres
2. Running incremental sync DAGs (every 10 minutes)
3. Running backfill DAGs with date parameters
4. Verifying post-processing: Gmail labels and IMAP folder moves

## Architecture

```
                    +-----------------+
                    |  Airflow DAGs   |
                    | - gmail_sync    |
                    | - imap_sync     |
                    | - gmail_backfill|
                    | - imap_backfill |
                    +--------+--------+
                             |
         +-------------------+-------------------+
         |                   |                   |
    +----v----+        +-----v-----+       +-----v-----+
    | Postgres|        |   MinIO   |       | Confluent |
    | accounts|        | raw .eml  |       | Kafka     |
    | watermarks        | files    |       | raw events|
    +----------        +----------+        +----------+
```

## Prerequisites

- Docker and Docker Compose
- Python 3.11+ with `uv`
- Gmail OAuth credentials (client ID, secret, refresh token)
- WorkMail IMAP credentials (or other IMAP server)
- Confluent Cloud Kafka cluster (optional for local testing)

## Environment Variables

### Required: Postgres

```bash
POSTGRES_HOST=localhost       # or 'postgres' inside compose network
POSTGRES_PORT=5432
POSTGRES_DB=lattice
POSTGRES_USER=lattice
POSTGRES_PASSWORD=<password>
```

### Required: MinIO/S3

```bash
MINIO_ENDPOINT=http://localhost:9000   # or 'http://minio:9000' inside compose
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
STORAGE_BUCKET=lattice-mail-raw
```

### Optional: Kafka (Confluent Cloud)

```bash
KAFKA_BOOTSTRAP_SERVERS=<cluster>.confluent.cloud:9092
KAFKA_SASL_USERNAME=<api-key>
KAFKA_SASL_PASSWORD=<api-secret>
```

### Gmail OAuth Credentials

```bash
GMAIL_CLIENT_ID=<oauth-client-id>
GMAIL_CLIENT_SECRET=<oauth-client-secret>
GMAIL_REFRESH_TOKEN=<refresh-token>
GMAIL_USER_EMAIL=user@gmail.com
```

### IMAP Credentials

```bash
IMAP_HOST=imap.mail.us-east-1.awsapps.com
IMAP_PORT=993
IMAP_USERNAME=user@workmail.example.com
IMAP_PASSWORD=<password>
IMAP_SOURCE_FOLDER=INBOX
```

### Account Configuration

```bash
TENANT_ID=personal
GMAIL_ACCOUNT_ID=personal-gmail
GMAIL_ALIAS=personal-gmail
IMAP_ACCOUNT_ID=workmail-imap
IMAP_ALIAS=workmail-processed
```

## Starting the Local Stack

1. **Start core services** (Postgres, MinIO, Airflow):

```bash
cd infra/local/compose
docker compose -f lattice-core.yml up -d postgres minio airflow-init
docker compose -f lattice-core.yml up -d airflow-webserver airflow-scheduler
```

2. **Wait for services to be healthy**:

```bash
docker compose -f lattice-core.yml ps
```

3. **Apply database migrations**:

```bash
# Migrations are applied automatically on first Postgres start
# Or manually:
docker exec -i lattice-postgres psql -U lattice -d lattice < \
    ../postgres/migrations/003_mail_accounts.sql
docker exec -i lattice-postgres psql -U lattice -d lattice < \
    ../postgres/migrations/004_mail_alias.sql
```

4. **Access Airflow UI**:
   - URL: http://localhost:8088
   - Username: `admin`
   - Password: `admin` <!-- pragma: allowlist secret -->

## Seeding Mail Accounts

1. **Set environment variables**:

```bash
export POSTGRES_HOST=localhost
export POSTGRES_PASSWORD=lattice_dev_password
export TENANT_ID=personal
export GMAIL_ACCOUNT_ID=personal-gmail
export GMAIL_ALIAS=personal-gmail
export IMAP_ACCOUNT_ID=workmail-imap
export IMAP_ALIAS=workmail-processed
export IMAP_SOURCE_FOLDER=INBOX
```

2. **Run the seed script**:

```bash
cd /path/to/lattice
uv run python -m scripts.seed_mail_accounts
```

Expected output:
```
Lattice Mail Accounts Seeder
========================================
Seeding Gmail account: personal-gmail
  Created/updated Gmail account: personal/personal-gmail (alias=personal-gmail)
Seeding IMAP account: workmail-imap
  Created/updated IMAP account: personal/workmail-imap (alias=workmail-processed)
========================================
Seeding complete!
```

## Configuring Airflow

### Option 1: Environment Variables (for local testing)

Set credentials in Airflow's environment. Edit `lattice-core.yml` to add:

```yaml
airflow-scheduler:
  environment:
    # ... existing vars ...
    GMAIL_CLIENT_ID: ${GMAIL_CLIENT_ID}
    GMAIL_CLIENT_SECRET: ${GMAIL_CLIENT_SECRET}
    GMAIL_REFRESH_TOKEN: ${GMAIL_REFRESH_TOKEN}
    GMAIL_USER_EMAIL: ${GMAIL_USER_EMAIL}
    IMAP_HOST: ${IMAP_HOST}
    IMAP_USERNAME: ${IMAP_USERNAME}
    IMAP_PASSWORD: ${IMAP_PASSWORD}
    # ... MinIO/Postgres vars ...
```

### Option 2: Airflow Connections (recommended for production)

Create connections in Airflow UI:

1. **Gmail OAuth Connection** (`google_cloud_default`):
   - Type: Google Cloud
   - Keyfile JSON: OAuth credentials JSON

2. **IMAP Connection** (`imap_workmail`):
   - Type: IMAP
   - Host: imap.mail.us-east-1.awsapps.com
   - Login: user@workmail.example.com
   - Password: <password>

3. **Postgres Connection** (`lattice_postgres`):
   - Type: Postgres
   - Host: postgres
   - Schema: lattice
   - Login: lattice
   - Password: <password>

## Running Incremental Sync DAGs

### Via Airflow UI

1. Navigate to http://localhost:8088
2. Enable DAGs:
   - `lattice__gmail_sync_incremental`
   - `lattice__imap_sync_incremental`
3. They will run automatically every 10 minutes

### Via CLI

```bash
# Trigger Gmail sync manually
airflow dags trigger lattice__gmail_sync_incremental

# Trigger IMAP sync manually
airflow dags trigger lattice__imap_sync_incremental
```

## Running Backfill DAGs

### Via Airflow UI

1. Navigate to the DAG (e.g., `lattice__gmail_backfill`)
2. Click "Trigger DAG w/ config"
3. Enter parameters:

```json
{
    "tenant_id": "personal",
    "account_id": "personal-gmail",
    "start_date": "2024-01-01",
    "end_date": "2024-01-31",
    "limit_per_run": 100
}
```

### Via CLI

**Gmail Backfill:**
```bash
airflow dags trigger lattice__gmail_backfill --conf '{
    "tenant_id": "personal",
    "account_id": "personal-gmail",
    "start_date": "2024-01-01",
    "end_date": "2024-01-31",
    "limit_per_run": 100
}'
```

**IMAP Backfill:**
```bash
airflow dags trigger lattice__imap_backfill --conf '{
    "tenant_id": "personal",
    "account_id": "workmail-imap",
    "folder": "INBOX",
    "start_date": "2024-01-01",
    "end_date": "2024-01-31",
    "limit_per_run": 100
}'
```

## Verification

### 1. Check MinIO for Stored Messages

```bash
# Install mc (MinIO client) if needed
mc alias set local http://localhost:9000 minioadmin minioadmin

# List Gmail messages
mc ls local/lattice-mail-raw/tenant/personal/account/personal-gmail/ --recursive

# List IMAP messages
mc ls local/lattice-mail-raw/tenant/personal/account/workmail-imap/ --recursive
```

Object key format:
```
tenant/{tenant}/account/{account_id}/alias/{alias}/provider/{provider}/message/{msg_id}/message.eml
```

### 2. Check Gmail Labels

After processing, messages should have the `Lattice/<alias>` label:

1. Open Gmail
2. Look for label: `Lattice/personal-gmail`
3. Processed messages will appear under this label

### 3. Check IMAP Folder Moves

After processing, messages should be moved to the alias folder:

1. Connect to IMAP server
2. Check for folder named `workmail-processed` (or your alias)
3. Processed messages will be in this folder

```bash
# Using openssl s_client for testing
openssl s_client -connect imap.mail.us-east-1.awsapps.com:993
# Then: a1 LOGIN user@workmail.example.com password
#       a2 LIST "" "*"
#       a3 SELECT workmail-processed
```

### 4. Check Kafka Events (if configured)

```bash
kcat -b <bootstrap-servers> \
    -X security.protocol=SASL_SSL \
    -X sasl.mechanisms=PLAIN \
    -X sasl.username=<api-key> \
    -X sasl.password=<api-secret> \
    -t lattice.mail.raw.v1 \
    -C -c 10
```

### 5. Check Watermarks in Postgres

```sql
-- Gmail watermarks (historyId)
SELECT * FROM mail_watermarks
WHERE provider = 'gmail' AND tenant_id = 'personal';

-- IMAP watermarks (uidvalidity, last_uid)
SELECT * FROM mail_watermarks
WHERE provider = 'imap' AND tenant_id = 'personal';
```

### 6. Verify mail-parser Consumption

If mail-parser worker is running:

```bash
docker logs lattice-mail-parser --tail 100
```

Check Postgres for parsed messages:
```sql
SELECT * FROM emails ORDER BY created_at DESC LIMIT 10;
```

## Known Limitations

1. **IMAP Attachments Manifest**: May be empty or incomplete initially. IMAP requires parsing the full message body to extract attachment metadata.

2. **Gmail Rate Limits**: Be cautious with large backfills. Use `limit_per_run` parameter.

3. **IMAP Date Filtering**: IMAP doesn't have efficient date-based queries. Backfill fetches all messages in folder and filters by internal date.

4. **COPYUID Support**: The IMAP connector uses COPYUID (UIDPLUS extension) when available. If not supported, a warning is logged but the move still succeeds.

## Troubleshooting

### DAG Not Appearing in Airflow

1. Check DAG files have correct permissions
2. Check Airflow scheduler logs: `docker logs lattice-airflow-scheduler`
3. Verify DAG syntax: `airflow dags list`

### "Account not found" Error

Run the seed script to create accounts in Postgres.

### Gmail "401 Unauthorized"

Refresh token may have expired. Obtain a new refresh token.

### IMAP Connection Timeout

1. Verify IMAP host is reachable
2. Check if port 993 is open
3. For WorkMail, ensure IMAP is enabled for the user

### Watermark Not Updating

Check Airflow task logs. Watermarks only update after all messages in a batch are successfully:
1. Stored to MinIO
2. Published to Kafka
3. Post-processed (labeled/moved)

## Security Notes

1. **Never commit credentials** - Use environment variables or Airflow connections
2. **PII in logs** - The DAGs avoid logging message content or email addresses
3. **Kafka SSL** - Always use SASL_SSL for Confluent Cloud
4. **IMAP SSL** - Always use port 993 (IMAPS) for encrypted connections
