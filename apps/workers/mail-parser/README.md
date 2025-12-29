# mail-parser

**Service**: `lattice-worker-mail-parser`

Parses raw RFC822 emails into structured format and stores them in Postgres.

## Topics

- **Input**: `lattice.mail.raw.v1` - Raw emails from fetcher
- **Output**: `lattice.mail.parse.v1` - Parsed emails for downstream processing
- **Output (Attachments)**: `lattice.mail.attachment.v1` - Extraction requests for PDF/DOCX
- **DLQ**: `lattice.dlq.mail.parse.v1`

## Local Development

This worker is started via:

```bash
docker compose -f infra/local/compose/lattice-core.yml -f infra/local/compose/lattice-workers.yml up -d mail-parser
```

### Dependencies

- Postgres (lattice-core.yml)
- MinIO (lattice-core.yml) - for storing attachments
- Kafka (Confluent Cloud)
- Datadog Agent (datadog.yml)

## Environment Variables

See `.env.example` for all configuration options. Key variables:

| Variable | Description |
|----------|-------------|
| `KAFKA_TOPIC_IN` | Input topic for raw emails |
| `KAFKA_TOPIC_OUT` | Output topic for parsed emails |
| `KAFKA_TOPIC_ATTACHMENT` | Topic for attachment extraction requests |
| `KAFKA_TOPIC_DLQ` | Dead letter queue topic |
