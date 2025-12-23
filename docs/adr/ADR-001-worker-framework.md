# ADR-001: Standardize Kafka Workers on NestJS

## Status
Accepted

## Date
2025-12-23

## Decision
All Node.js Kafka workers in the Lattice monorepo will be implemented using **TypeScript + NestJS** as the application framework, with **KafkaJS** as the Kafka client library (via `packages/core-kafka`).

NestJS will be used for:
- Dependency injection (DI) and modular boundaries
- Lifecycle management (startup/shutdown)
- Configuration validation and composition
- Structured logging and telemetry wiring
- Testing conventions and consistent worker scaffolding

KafkaJS will be used for:
- Producer/consumer connectivity to Confluent Cloud
- Consumer group configuration and rebalance handling
- Backoff/retry strategy and DLQ publishing (centralized in `core-kafka`)
- Header propagation for tracing context

## Context
Lattice is an event-driven ingestion and indexing platform with multiple long-running Kafka worker services (parse, chunk, embed, upsert, delete, audit) and a requirement to:
- Maintain consistent implementation patterns across workers
- Enforce contract-first schemas and deterministic idempotency
- Instrument from day one with Datadog (logs, metrics, traces) using consistent tags
- Support clean operational behaviors: graceful shutdown, health checks, config validation
- Enable rapid development with AI-assisted coding while preventing architectural drift

Because Lattice will grow into a multi-service platform (including future agent-facing APIs), a consistent Node service framework improves maintainability and reduces integration friction.

## Alternatives Considered

### A) Framework-light TypeScript (KafkaJS + manual DI)
**Pros**
- Minimal overhead
- Fewer framework dependencies

**Cons**
- Repeated boilerplate across workers (DI, lifecycle, config)
- Higher drift risk across services
- Less predictable structure for AI-assisted development
- More bespoke testing patterns

### B) Fastify-based services + custom worker runner
**Pros**
- High performance for HTTP use cases
- Smaller framework surface area

**Cons**
- Still requires custom worker lifecycle/runtime composition
- Not inherently better for Kafka consumer processes than NestJS
- Similar drift risk without a strong module/DI pattern

### C) NestJS Microservices Kafka Transport (Nest built-in)
**Pros**
- “Batteries-included” messaging abstraction

**Cons**
- Abstraction can obscure important Kafka/Confluent operational controls
- Harder to enforce platform-wide idempotency, DLQ, and header propagation uniformly
- Less direct control over consumer behaviors and tuning

## Rationale
NestJS provides a standardized, opinionated service structure well-suited to long-running worker processes and aligns with enterprise development practices. It also improves repeatability and correctness when generating code with AI tools by reinforcing consistent module boundaries and lifecycle hooks.

We explicitly retain KafkaJS as the Kafka transport implementation via `core-kafka` to ensure:
- Full operational control of consumers and producers
- Consistent error classification and DLQ behaviors
- Predictable tracing header propagation
- Minimal abstraction leakage to worker business logic

## Consequences

### Positive
- Uniform worker structure across all Kafka services
- Consistent lifecycle: startup, readiness, graceful shutdown
- Easier and safer application of shared platform libraries (`core-kafka`, `core-telemetry`, `core-config`)
- Improved testability and refactoring consistency
- Better alignment with future HTTP/API services under the same framework

### Negative
- Additional framework dependency footprint
- Slightly higher baseline complexity than a single-file consumer
- Requires a clear boundary: NestJS for app structure; KafkaJS for transport

## Implementation Notes
- Each worker is a NestJS application with:
  - `AppModule` wiring dependencies
  - `WorkerService` owning the consumer loop
  - Controlled shutdown hooks (SIGTERM/SIGINT)
- Kafka access must flow through `packages/core-kafka`
- Telemetry and tagging must flow through `packages/core-telemetry`
- No business logic belongs in `core-kafka`; workers own domain logic and persistence.

## Follow-ups
- Update `docs/architecture/scope-v1.md` to record the adopted stack
- Ensure new worker scaffolds follow a common template:
  - consistent env var names
  - consistent Datadog tags
  - consistent DLQ conventions
