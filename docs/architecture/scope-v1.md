## Technology Stack (v1)

### Kafka Workers
- Language: TypeScript (Node.js)
- Framework: NestJS (standardized worker framework)
- Kafka Client: KafkaJS (via `packages/core-kafka`)
- Packaging: pnpm workspace monorepo

### Orchestration
- Language: Python
- Orchestrator: Apache Airflow (DAGs orchestrate; workers execute)

### Storage & Retrieval
- System of Record + Lexical Search: Postgres (FTS)
- Vector Index: Milvus (self-hosted)

### Messaging
- Kafka: Confluent Cloud (topics `lattice.mail.*.v1` and DLQs)

### Observability
- Datadog Cloud (logs, metrics, traces), with unified service tagging enforced

## Mail Ingestion (v1)

### Supported Providers
- **Gmail (API)**: OAuth-based access via Gmail API with history-based incremental sync
- **IMAP**: Standard IMAP protocol for WorkMail and other IMAP-compatible providers

### Multi-Account Support
- Multiple accounts per provider can be configured in Postgres (`mail_accounts` table)
- Each account has a unique `account_id` within a tenant
- Watermarks tracked per account/scope in `mail_watermarks` table

### Provider-Neutral Pipeline
- All providers emit to the same `lattice.mail.raw.v1` topic
- Downstream workers (parse, chunk, embed) are provider-agnostic
- Provider-specific metadata preserved in dedicated schema fields

See [mail-sources.md](./mail-sources.md) for detailed provider documentation.
