# Demo: Two-Inbox Mail Ingestion

This runbook describes how to run the two-inbox demo that fetches messages from Gmail API and IMAP (e.g., Amazon WorkMail) and ingests them into the Lattice pipeline.

## Overview

The demo script (`python/scripts/demo_fetch_two_inboxes.py`) demonstrates Phase 2 multi-provider ingestion:

1. Seeds mail_accounts in Postgres
2. Fetches messages from Gmail API and/or IMAP
3. Stores raw `.eml` files to MinIO (S3-compatible storage)
4. Publishes `lattice.mail.raw.v1` events to Kafka
5. Updates watermarks for incremental sync

## Prerequisites

- Python 3.11+
- Docker (for local MinIO and Postgres)
- Access to Gmail OAuth credentials or IMAP server
- (Optional) Confluent Cloud Kafka cluster

## Environment Variables

### Required: Postgres

```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=lattice
POSTGRES_USER=lattice
POSTGRES_PASSWORD=<your-password>
```

### Required: MinIO/S3

```bash
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=<your-access-key>
MINIO_SECRET_KEY=<your-secret-key>
STORAGE_BUCKET=lattice-mail-raw
```

### Optional: Kafka (Confluent Cloud)

If not configured, events will be logged but not published.

```bash
KAFKA_BOOTSTRAP_SERVERS=<cluster>.confluent.cloud:9092
KAFKA_SASL_USERNAME=<api-key>
KAFKA_SASL_PASSWORD=<api-secret>
```

### Gmail OAuth (if using Gmail)

```bash
GMAIL_CLIENT_ID=<oauth-client-id>
GMAIL_CLIENT_SECRET=<oauth-client-secret>
GMAIL_REFRESH_TOKEN=<refresh-token>
GMAIL_USER_EMAIL=user@example.com
```

To obtain Gmail OAuth credentials:
1. Create a project in Google Cloud Console
2. Enable Gmail API
3. Create OAuth 2.0 credentials (Desktop app type)
4. Use the OAuth Playground or a script to obtain a refresh token with `gmail.readonly` scope

### IMAP (if using WorkMail or other IMAP server)

```bash
IMAP_HOST=imap.mail.us-east-1.awsapps.com
IMAP_PORT=993
IMAP_USERNAME=user@workmail.example.com
IMAP_PASSWORD=<imap-password>
IMAP_FOLDERS=INBOX,Sent
```

### Account Configuration

```bash
TENANT_ID=personal
GMAIL_ACCOUNT_ID=personal-gmail
IMAP_ACCOUNT_ID=workmail-imap
MAX_MESSAGES=10
```

## Starting Local Services

### MinIO (S3-compatible storage)

```bash
docker run -d \
  --name minio \
  -p 9000:9000 \
  -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```

Access MinIO Console at http://localhost:9001 (minioadmin/minioadmin).

### Postgres

If not using Docker Compose from the main stack:

```bash
docker run -d \
  --name postgres \
  -p 5432:5432 \
  -e POSTGRES_USER=lattice \
  -e POSTGRES_PASSWORD=lattice \
  -e POSTGRES_DB=lattice \
  postgres:15
```

### Apply Migrations

Before running the demo, ensure database migrations are applied:

```bash
cd infra/local
docker compose up -d postgres
# Apply migrations using your preferred method
```

The required tables are:
- `mail_accounts` - Account configurations
- `mail_watermarks` - Sync watermarks

## Running the Demo

1. Set up Python environment:

```bash
cd /path/to/lattice
uv sync
```

2. Export environment variables (or use a `.env` file):

```bash
export POSTGRES_HOST=localhost
export POSTGRES_PASSWORD=lattice
export MINIO_ENDPOINT=http://localhost:9000
export MINIO_ACCESS_KEY=minioadmin
export MINIO_SECRET_KEY=minioadmin
# ... add other required variables
```

3. Run the demo script:

```bash
uv run python -m scripts.demo_fetch_two_inboxes
```

## Expected Output

```
2024-12-24 10:00:00 - __main__ - INFO - ============================================================
2024-12-24 10:00:00 - __main__ - INFO - Lattice Two-Inbox Demo
2024-12-24 10:00:00 - __main__ - INFO - ============================================================
2024-12-24 10:00:00 - __main__ - INFO - Storage bucket ready: lattice-mail-raw
2024-12-24 10:00:01 - __main__ - INFO - ----------------------------------------
2024-12-24 10:00:01 - __main__ - INFO - Processing Gmail account: personal-gmail
2024-12-24 10:00:01 - __main__ - INFO - ----------------------------------------
2024-12-24 10:00:02 - __main__ - INFO - Gmail profile: historyId=12345
2024-12-24 10:00:02 - __main__ - INFO - Found 10 messages matching query: newer_than:7d
...
2024-12-24 10:00:10 - __main__ - INFO - ============================================================
2024-12-24 10:00:10 - __main__ - INFO - Demo Complete - Summary
2024-12-24 10:00:10 - __main__ - INFO - ============================================================
2024-12-24 10:00:10 - __main__ - INFO - Gmail: 10 fetched, 10 stored, 10 published
2024-12-24 10:00:10 - __main__ - INFO - IMAP:  5 fetched, 5 stored, 5 published
```

## Verifying Messages Landed

### MinIO (Object Storage)

1. Open MinIO Console: http://localhost:9001
2. Navigate to the `lattice-mail-raw` bucket
3. Browse to `tenant/{tenant_id}/account/{account_id}/provider/{provider}/message/`
4. Verify `.eml` files are present

Using CLI:

```bash
# Install mc (MinIO client)
mc alias set local http://localhost:9000 minioadmin minioadmin
mc ls local/lattice-mail-raw/tenant/personal/account/personal-gmail/provider/gmail/message/ --recursive
```

### Kafka (if configured)

Using Confluent Cloud Console or kcat:

```bash
kcat -b <bootstrap-servers> \
  -X security.protocol=SASL_SSL \
  -X sasl.mechanisms=PLAIN \
  -X sasl.username=<api-key> \
  -X sasl.password=<api-secret> \
  -t lattice.mail.raw.v1 \
  -C -c 10
```

### Postgres (Watermarks)

```sql
SELECT * FROM mail_watermarks
WHERE tenant_id = 'personal';
```

```sql
SELECT * FROM mail_accounts
WHERE tenant_id = 'personal';
```

## Known Limitations

1. **IMAP Attachments Manifest**: The attachments manifest for IMAP messages may be empty or incomplete. IMAP does not provide attachment metadata without parsing the full message body. The manifest is populated on a best-effort basis by parsing the raw RFC822 content.

2. **Gmail Rate Limits**: The Gmail API has rate limits. For production use, implement exponential backoff and respect quota limits.

3. **No Deduplication**: The demo script does not check for already-processed messages. Running it multiple times may create duplicate entries. Use watermarks to track progress in production.

4. **Single-threaded**: The demo runs sequentially. Production implementations should parallelize message fetching.

## Troubleshooting

### "Required environment variable X is not set"

Ensure all required environment variables are exported. Check spelling and ensure no trailing whitespace.

### "Connection refused" to Postgres/MinIO

Verify Docker containers are running:

```bash
docker ps
```

### Gmail "401 Unauthorized"

The refresh token may have expired. Re-authenticate and obtain a new refresh token.

### IMAP "Login failed"

- Verify credentials are correct
- For WorkMail, ensure the user has IMAP access enabled
- Check if the IMAP server requires app-specific passwords

### Kafka "Authentication failed"

- Verify SASL credentials
- Ensure the API key has produce permissions on the topic
