# attachment-chunker

**Service**: `lattice-worker-attachment-chunker`

Chunks extracted attachment text for embedding. This worker completes the attachment pipeline by taking extracted text from PDF/DOCX files and chunking it for vector embedding.

## Topics

- **Input**: `lattice.mail.attachment.extracted.v1` - Extraction complete notifications
- **Output**: `lattice.mail.chunk.v1` - Chunks ready for embedding
- **DLQ**: `lattice.dlq.mail.attachment.chunk.v1`

## Pipeline Position

```
mail-parser → attachment.v1 → mail-extractor → attachment.extracted.v1 → attachment-chunker → chunk.v1 → embedder → Milvus
```

## Local Development

This worker is started via:

```bash
docker compose -f infra/local/compose/lattice-core.yml -f infra/local/compose/lattice-workers.yml up -d attachment-chunker
```

### Dependencies

- Postgres (lattice-core.yml) - for fetching extracted text
- Kafka (Confluent Cloud)
- Datadog Agent (datadog.yml)

## Environment Variables

See `.env.example` for all configuration options. Key variables:

| Variable | Description |
|----------|-------------|
| `KAFKA_TOPIC_IN` | Input topic for extraction complete events |
| `KAFKA_TOPIC_OUT` | Output topic for chunk events |
| `KAFKA_TOPIC_DLQ` | Dead letter queue topic |
| `CHUNK_TARGET_TOKENS` | Target tokens per chunk (default: 400) |
| `CHUNK_OVERLAP_TOKENS` | Overlap between chunks (default: 50) |
| `CHUNK_MAX_TOKENS` | Maximum tokens per chunk (default: 512) |

## Behavior

1. Receives extraction complete notification from mail-extractor
2. Skips if extraction failed or unsupported
3. Fetches extracted text from Postgres `email_attachment` table
4. Chunks text using configurable token limits
5. Emits chunk events to `lattice.mail.chunk.v1`
6. Chunks flow through existing embedder → upserter → Milvus

## Chunk Metadata

All chunks include:
- `source_type: "attachment"` - Distinguishes from body/subject chunks
- `attachment_id` - Links back to the source attachment
- `section_type: "attachment_text"` - Semantic classification
