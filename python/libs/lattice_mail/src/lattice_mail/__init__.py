"""Lattice mail processing utilities."""

from lattice_mail.account_registry import AccountRegistry, MailAccount
from lattice_mail.connectors import GmailConnector, ImapConnector
from lattice_mail.raw_event import (
    INLINE_THRESHOLD_BYTES,
    MAX_EMAIL_SIZE_BYTES,
    RawMailEvent,
    build_raw_event,
)
from lattice_mail.watermarks import Watermark, WatermarkStore

__all__ = [
    "GmailConnector",
    "ImapConnector",
    "build_raw_event",
    "RawMailEvent",
    "INLINE_THRESHOLD_BYTES",
    "MAX_EMAIL_SIZE_BYTES",
    "AccountRegistry",
    "MailAccount",
    "WatermarkStore",
    "Watermark",
]
