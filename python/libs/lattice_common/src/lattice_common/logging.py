"""Logging configuration for Lattice Python components."""
import logging
import sys
from typing import Any

from pythonjsonlogger import jsonlogger

from .config import get_config


class LatticeJsonFormatter(jsonlogger.JsonFormatter):
    """Custom JSON formatter with Datadog-compatible fields."""

    def add_fields(
        self,
        log_record: dict[str, Any],
        record: logging.LogRecord,
        message_dict: dict[str, Any],
    ) -> None:
        super().add_fields(log_record, record, message_dict)

        config = get_config()

        # Add Datadog unified service tags
        log_record["env"] = config.env
        log_record["service"] = config.service.name
        log_record["version"] = config.service.version

        # Add additional context
        log_record["level"] = record.levelname
        log_record["logger"] = record.name

        # Datadog expects 'message' field
        if "message" not in log_record:
            log_record["message"] = record.getMessage()


def configure_logging(level: str = "INFO") -> None:
    """Configure structured JSON logging for Datadog."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        LatticeJsonFormatter(
            fmt="%(timestamp)s %(level)s %(name)s %(message)s",
            rename_fields={"timestamp": "@timestamp"},
        )
    )

    root_logger = logging.getLogger()
    root_logger.handlers = [handler]
    root_logger.setLevel(getattr(logging, level.upper()))

    # Reduce noise from libraries
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("kafka").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Get a logger with the given name."""
    return logging.getLogger(name)
