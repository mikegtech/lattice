# Lattice Architecture

This directory documents architectural decisions and system structure.

## Files

- `scope-v1.md`
  Overall system scope and boundaries.

- `worker-template.md`
  Standard NestJS Kafka worker template and invariants.

- `adr/`
  Architecture Decision Records (ADRs).

- `mail-sources.md`
  Provider model (Gmail API + IMAP).

---

## Architectural Principles

- Event-driven, Kafka-first
- Provider-neutral ingestion
- Idempotency at every stage
- Separation of control-plane (Airflow) and data-plane (workers)
- Observable by default (Datadog)

All new changes must align with these principles.
