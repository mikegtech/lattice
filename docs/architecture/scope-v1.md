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
