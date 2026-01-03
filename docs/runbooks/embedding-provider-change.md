# Embedding Provider Change Runbook

This runbook describes how to change the embedding provider and perform the required data sweep when switching models.

## Available Embedding Providers

| Provider | Model | Dimensions | Token Context | Endpoint |
|----------|-------|------------|---------------|----------|
| `nomic` | nomic-embed-text-v1.5 | 768 | 8192 | `http://dataops.trupryce.ai:8001` |
| `e5` | e5-base-v2 | 768 | 512 | `http://dataops.trupryce.ai:8000` |
| `openai` | text-embedding-3-small | 768 (configurable) | 8191 | OpenAI API |

## Prerequisites

- Access to the compose environment
- Docker and docker-compose installed
- Access to Postgres and Milvus

## Procedure

### Step 1: Update Configuration

Edit `infra/local/compose/lattice-workers.yml` and change the `EMBEDDING_PROVIDER` value:

```yaml
# Embedding provider config
EMBEDDING_PROVIDER: nomic  # Options: nomic, e5, openai
```

### Step 2: Clear Postgres Data

Connect to Postgres and delete existing embeddings and chunks:

```bash
docker exec lattice-postgres psql -U lattice -d lattice -c "
DELETE FROM email_embedding;
DELETE FROM email_chunk;
DELETE FROM email_attachment;
DELETE FROM email;
"
```

### Step 3: Drop and Recreate Milvus Collection

Drop the existing collection (vectors are incompatible between models):

```bash
docker exec lattice-mail-upserter node -e "
const { MilvusClient } = require('@zilliz/milvus2-sdk-node');
async function reset() {
  const client = new MilvusClient({ address: 'milvus:19530', timeout: 10000 });
  const has = await client.hasCollection({ collection_name: 'email_chunks_v1' });
  if (has.value) {
    await client.dropCollection({ collection_name: 'email_chunks_v1' });
    console.log('Collection dropped');
  }
  await client.closeConnection();
}
reset().catch(e => console.error(e.message));
"
```

Recreate the collection with correct dimensions (768 for all current providers):

```bash
docker exec lattice-mail-upserter node -e "
const { MilvusClient, DataType } = require('@zilliz/milvus2-sdk-node');
async function create() {
  const client = new MilvusClient({ address: 'milvus:19530', timeout: 10000 });
  await client.createCollection({
    collection_name: 'email_chunks_v1',
    fields: [
      { name: 'pk', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
      { name: 'tenant_id', data_type: DataType.VarChar, max_length: 255 },
      { name: 'account_id', data_type: DataType.VarChar, max_length: 255 },
      { name: 'alias', data_type: DataType.VarChar, max_length: 255 },
      { name: 'email_id', data_type: DataType.VarChar, max_length: 36 },
      { name: 'chunk_hash', data_type: DataType.VarChar, max_length: 64 },
      { name: 'embedding_version', data_type: DataType.VarChar, max_length: 50 },
      { name: 'embedding_model', data_type: DataType.VarChar, max_length: 100 },
      { name: 'section_type', data_type: DataType.VarChar, max_length: 30 },
      { name: 'email_timestamp', data_type: DataType.Int64 },
      { name: 'vector', data_type: DataType.FloatVector, dim: 768 }
    ]
  });
  await client.createIndex({
    collection_name: 'email_chunks_v1',
    field_name: 'vector',
    index_type: 'HNSW',
    metric_type: 'COSINE',
    params: { M: 16, efConstruction: 256 }
  });
  await client.loadCollection({ collection_name: 'email_chunks_v1' });
  console.log('Collection created with 768 dims');
  await client.closeConnection();
}
create().catch(e => console.error(e.message));
"
```

### Step 4: Restart Workers

Force recreate the mail-embedder and mail-upserter to pick up the new configuration:

```bash
cd infra/local/compose
docker compose -f lattice-workers.yml up -d --force-recreate mail-embedder mail-upserter
```

### Step 5: Verify Configuration

Check that the new provider is active:

```bash
docker compose -f lattice-workers.yml logs mail-embedder --tail=20 | grep -i "provider\|Using"
```

Expected output for Nomic:
```
"provider":"nomic"
"msg":"Using Nomic embedding provider"
```

### Step 6: Re-ingest Emails

Trigger a backfill of emails through the pipeline, or send test emails to verify the new embeddings are being created correctly.

### Step 7: Verify Embeddings

Check that embeddings are using the correct model:

```bash
docker exec lattice-postgres psql -U lattice -d lattice -c "
SELECT embedding_model, COUNT(*) FROM email_embedding GROUP BY embedding_model;
"
```

Check Milvus vectors:

```bash
curl -s "http://localhost:19530/v1/vector/query" \
  -d '{"collectionName": "email_chunks_v1", "outputFields": ["embedding_model"], "limit": 5}' | jq '.data[].embedding_model'
```

## RAG API Configuration

When changing embedding providers, ensure the RAG API at `api.woodcreek.ai` uses the matching model for query embedding:

```json
{
  "embedding_model": "nomic"
}
```

### Provider-Specific Notes

#### E5 Provider
- Requires `"query: "` prefix for search queries
- Requires `"passage: "` prefix for documents (handled by mail-embedder)
- Higher relevance thresholds may be needed

#### Nomic Provider
- Uses `"search_query: "` prefix for queries
- Uses `"search_document: "` prefix for documents
- Generally works with lower relevance thresholds (0.35)

## Rollback

To rollback to a previous provider, repeat the entire procedure with the previous provider configuration.

## Troubleshooting

### Embeddings show "already exists" but wrong model

The Postgres `email_embedding` table wasn't cleared. Run the DELETE statements in Step 2.

### Milvus upsert fails

The collection may have wrong dimensions or doesn't exist. Drop and recreate per Step 3.

### RAG returns no results

Ensure the RAG API is configured to use the same embedding model as the stored vectors. Mismatched models will produce meaningless similarity scores.
