# Mail Contracts

This directory contains JSON Schema contracts for the mail domain Kafka topics.

## Provider-Neutral Design

The `raw/v1` schema is designed to support multiple mail providers (Gmail API, IMAP) with a unified structure. Provider-specific metadata is isolated in dedicated objects.

## Field Mapping by Provider

### Common Fields (Required)

| Field | Gmail | IMAP |
|-------|-------|------|
| `provider_message_id` | Gmail message ID | `{uidvalidity}:{uid}` |
| `email_id` | Lattice-assigned UUID | Lattice-assigned UUID |
| `received_at` | `internal_date` | IMAP INTERNALDATE |
| `raw_object_uri` | GCS/S3 URI | GCS/S3 URI |
| `raw_format` | `gmail_raw` or `gmail_full` | `rfc822` |
| `fetched_at` | Fetch timestamp | Fetch timestamp |

### Optional Common Fields

| Field | Gmail | IMAP |
|-------|-------|------|
| `provider_thread_id` | Gmail thread ID | Not used (null) |
| `raw_payload` | Base64url RFC822 (small msgs) | Base64 RFC822 (small msgs) |
| `size_bytes` | Payload size | Payload size |
| `attachments_manifest[]` | From Gmail API parts | Parsed from MIME |
| `headers_subset` | Extracted headers | Extracted headers |

### Provider-Specific Metadata

#### Gmail (`gmail_metadata`)

```json
{
  "history_id": "12345",
  "label_ids": ["INBOX", "UNREAD"],
  "internal_date": "2024-01-15T10:30:00Z"
}
```

#### IMAP (`imap_metadata`)

```json
{
  "uid": 67890,
  "uidvalidity": 12345,
  "folder": "INBOX",
  "flags": ["\\Seen", "\\Flagged"]
}
```

## Envelope `provider_source` Block

The envelope includes a `provider_source` object for routing and audit:

```json
{
  "provider_source": {
    "provider": "gmail",
    "account_id": "user@example.com",
    "scope": "label:important",
    "provider_message_id": "18d1a2b3c4d5e6f7",
    "provider_thread_id": "18d1a2b3c4d5e6f0"
  }
}
```

For IMAP:

```json
{
  "provider_source": {
    "provider": "imap",
    "account_id": "user@workmail.example.com",
    "scope": "INBOX",
    "provider_message_id": "12345:67890"
  }
}
```

## Backward Compatibility

The v1 schema is additive:
- New optional fields added for provider flexibility
- `gmail_metadata` preserves Gmail-specific fields from the original schema
- `imap_metadata` added for IMAP support
- Required fields remain stable
