# Mail Sources

This document describes the mail providers supported by Lattice and how they integrate into the pipeline.

## Supported Providers

### Gmail (API)

Gmail ingestion uses the Gmail API with OAuth 2.0 authentication.

**Features:**
- History-based incremental sync using `historyId`
- Label-based scoping (e.g., `INBOX`, `label:important`)
- Thread grouping via `threadId`
- Push notifications via Gmail watch

**Configuration (`config_json`):**
```json
{
  "email": "user@gmail.com",
  "scopes": ["INBOX"],
  "watch_labels": ["INBOX", "SENT"]
}
```

**Watermark (`watermark_json`):**
```json
{
  "historyId": "12345678"
}
```

### IMAP (WorkMail, etc.)

IMAP ingestion uses standard IMAP protocol, suitable for AWS WorkMail and other IMAP-compatible providers.

**Features:**
- UID-based incremental sync
- Folder-based scoping (e.g., `INBOX`, `Sent`)
- UIDVALIDITY tracking for mailbox changes

**Configuration (`config_json`):**
```json
{
  "host": "imap.mail.us-east-1.awsapps.com",
  "port": 993,
  "tls": true,
  "folders": ["INBOX", "Sent"]
}
```

**Watermark (`watermark_json`):**
```json
{
  "uidvalidity": 12345,
  "last_uid": 67890
}
```

## Account ID Concept

The `account_id` is a logical identifier for a mailbox within a tenant:

- **Uniqueness**: Unique per `(tenant_id, account_id)` pair
- **Format**: Typically the email address or a custom identifier
- **Stability**: Should not change over the account lifetime
- **Provider-agnostic**: Same account_id used across all pipeline stages

Example account IDs:
- `user@company.com` (email-based)
- `acct_abc123` (custom identifier)

## Watermarking Concept

Watermarks enable incremental sync by tracking the last successfully processed position.

### Purpose
- Avoid re-processing already-ingested emails
- Enable efficient delta syncs
- Support resumption after failures

### Per-Scope Tracking

Watermarks are tracked per `(tenant_id, account_id, provider, scope)`:

| Provider | Scope Examples | Watermark Fields |
|----------|----------------|------------------|
| Gmail | `INBOX`, `label:work` | `historyId` |
| IMAP | `INBOX`, `Sent` | `uidvalidity`, `last_uid` |

### UIDVALIDITY Handling (IMAP)

IMAP mailboxes have a `UIDVALIDITY` value that changes when UIDs are reassigned:
- If `UIDVALIDITY` changes, the entire folder must be re-synced
- Watermarks store both `uidvalidity` and `last_uid` to detect this condition

## Data Flow

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│   Gmail     │────▶│   Airflow   │────▶│ lattice.mail.raw │
│   API       │     │   DAG       │     │       .v1        │
└─────────────┘     └─────────────┘     └──────────────────┘
                           │                     │
┌─────────────┐            │                     ▼
│   IMAP      │────────────┘            ┌──────────────────┐
│   Server    │                         │   mail-parser    │
└─────────────┘                         │     worker       │
                                        └──────────────────┘
```

All providers emit to the same `lattice.mail.raw.v1` topic. Downstream workers are provider-agnostic.
