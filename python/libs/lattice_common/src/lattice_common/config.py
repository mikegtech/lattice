"""Configuration management for Lattice Python components."""
import os
from functools import lru_cache

from pydantic import BaseModel, Field


class ServiceIdentity(BaseModel):
    """Service identity for telemetry."""

    name: str
    version: str
    team: str = "platform"
    cloud: str = "gcp"
    region: str = "us-central1"
    domain: str = "mail"
    pipeline: str = "mail-indexing"


class KafkaConfig(BaseModel):
    """Kafka configuration."""

    bootstrap_servers: str
    security_protocol: str = "SASL_SSL"
    sasl_mechanism: str = "PLAIN"
    sasl_username: str | None = None
    sasl_password: str | None = None


class PostgresConfig(BaseModel):
    """Postgres configuration."""

    host: str = "localhost"
    port: int = 5432
    database: str = "lattice"
    user: str = "lattice"
    password: str


class LatticeConfig(BaseModel):
    """Main configuration for Lattice components."""

    env: str = Field(default="dev")
    service: ServiceIdentity
    kafka: KafkaConfig
    postgres: PostgresConfig
    log_level: str = "INFO"


@lru_cache
def get_config() -> LatticeConfig:
    """Load configuration from environment variables."""
    return LatticeConfig(
        env=os.getenv("ENV", "dev"),
        service=ServiceIdentity(
            name=os.getenv("SERVICE_NAME", "lattice-python"),
            version=os.getenv("SERVICE_VERSION", "0.1.0"),
            team=os.getenv("TEAM", "platform"),
            cloud=os.getenv("CLOUD", "gcp"),
            region=os.getenv("REGION", "us-central1"),
            domain=os.getenv("DOMAIN", "mail"),
            pipeline=os.getenv("PIPELINE", "mail-indexing"),
        ),
        kafka=KafkaConfig(
            bootstrap_servers=os.getenv("KAFKA_BOOTSTRAP_SERVERS", ""),
            security_protocol=os.getenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL"),
            sasl_mechanism=os.getenv("KAFKA_SASL_MECHANISM", "PLAIN"),
            sasl_username=os.getenv("KAFKA_SASL_USERNAME"),
            sasl_password=os.getenv("KAFKA_SASL_PASSWORD"),
        ),
        postgres=PostgresConfig(
            host=os.getenv("POSTGRES_HOST", "localhost"),
            port=int(os.getenv("POSTGRES_PORT", "5432")),
            database=os.getenv("POSTGRES_DB", "lattice"),
            user=os.getenv("POSTGRES_USER", "lattice"),
            password=os.getenv("POSTGRES_PASSWORD", ""),
        ),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
    )
