"""Kafka producer for Confluent Cloud with SASL_SSL support."""

import json
import logging
import os
from typing import Any

from confluent_kafka import Producer
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class KafkaProducerConfig(BaseModel):
    """Configuration for Kafka producer."""

    bootstrap_servers: str
    security_protocol: str = "SASL_SSL"
    sasl_mechanism: str = "PLAIN"
    sasl_username: str
    sasl_password: str
    client_id: str = "lattice-python"

    @classmethod
    def from_env(cls) -> "KafkaProducerConfig":
        """Load configuration from environment variables."""
        return cls(
            bootstrap_servers=os.getenv("KAFKA_BOOTSTRAP_SERVERS", ""),
            security_protocol=os.getenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL"),
            sasl_mechanism=os.getenv("KAFKA_SASL_MECHANISM", "PLAIN"),
            sasl_username=os.getenv("KAFKA_SASL_USERNAME", ""),
            sasl_password=os.getenv("KAFKA_SASL_PASSWORD", ""),
            client_id=os.getenv("KAFKA_CLIENT_ID", "lattice-python"),
        )


class KafkaProducer:
    """Kafka producer for Confluent Cloud."""

    def __init__(self, config: KafkaProducerConfig | None = None) -> None:
        """Initialize Kafka producer with config."""
        self.config = config or KafkaProducerConfig.from_env()

        producer_config: dict[str, Any] = {
            "bootstrap.servers": self.config.bootstrap_servers,
            "client.id": self.config.client_id,
        }

        # Add SASL config if using SASL_SSL
        if self.config.security_protocol == "SASL_SSL":
            producer_config.update(
                {
                    "security.protocol": "SASL_SSL",
                    "sasl.mechanism": self.config.sasl_mechanism,
                    "sasl.username": self.config.sasl_username,
                    "sasl.password": self.config.sasl_password,
                }
            )
        elif self.config.security_protocol == "PLAINTEXT":
            producer_config["security.protocol"] = "PLAINTEXT"

        self._producer = Producer(producer_config)
        self._delivery_errors: list[str] = []

    def _delivery_callback(self, err: Any, msg: Any) -> None:
        """Callback for message delivery."""
        if err is not None:
            error_msg = f"Delivery failed for {msg.topic()}[{msg.partition()}]: {err}"
            logger.error(error_msg)
            self._delivery_errors.append(error_msg)
        else:
            logger.debug(
                "Delivered to %s[%d] at offset %d",
                msg.topic(),
                msg.partition(),
                msg.offset(),
            )

    def publish(
        self,
        topic: str,
        key: str,
        value: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> None:
        """
        Publish a message to Kafka.

        Args:
            topic: Kafka topic name
            key: Message key (used for partitioning)
            value: Message value (will be JSON serialized)
            headers: Optional message headers
        """
        value_bytes = json.dumps(value).encode("utf-8")
        key_bytes = key.encode("utf-8")

        # Convert headers dict to list of tuples
        header_list: list[tuple[str, bytes]] | None = None
        if headers:
            header_list = [(k, v.encode("utf-8")) for k, v in headers.items()]

        self._producer.produce(
            topic=topic,
            key=key_bytes,
            value=value_bytes,
            headers=header_list,
            callback=self._delivery_callback,
        )

        # Trigger delivery callbacks
        self._producer.poll(0)

    def flush(self, timeout: float = 30.0) -> int:
        """
        Wait for all messages to be delivered.

        Args:
            timeout: Maximum time to wait in seconds

        Returns:
            Number of messages still in queue (0 if all delivered)

        Raises:
            RuntimeError: If there were delivery errors
        """
        remaining = self._producer.flush(timeout)

        if self._delivery_errors:
            errors = self._delivery_errors.copy()
            self._delivery_errors.clear()
            raise RuntimeError(f"Kafka delivery errors: {errors}")

        return remaining

    def close(self) -> None:
        """Flush and close the producer."""
        self.flush()


# Topic constants
TOPIC_MAIL_RAW = "lattice.mail.raw.v1"
TOPIC_MAIL_PARSE = "lattice.mail.parse.v1"
TOPIC_MAIL_CHUNK = "lattice.mail.chunk.v1"
TOPIC_MAIL_EMBED = "lattice.mail.embed.v1"
TOPIC_MAIL_UPSERT = "lattice.mail.upsert.v1"
TOPIC_MAIL_DLQ = "lattice.mail.dlq.v1"
