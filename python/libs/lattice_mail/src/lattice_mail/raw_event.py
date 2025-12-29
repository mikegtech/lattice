"""Provider-neutral raw mail event builder for lattice.mail.raw.v1."""

import base64
import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

# Claim check pattern thresholds
INLINE_THRESHOLD_BYTES = 256 * 1024  # 256 KB - inline payload if under this
MAX_EMAIL_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB - reject emails larger than this


@dataclass
class AttachmentManifestItem:
    """Attachment manifest entry."""

    attachment_id: str
    filename: str
    content_type: str
    size_bytes: int
    object_uri: str | None = None


@dataclass
class RawMailEvent:
    """Provider-neutral raw mail event payload."""

    # Required fields
    provider_message_id: str
    email_id: str
    received_at: datetime
    raw_object_uri: str
    raw_format: Literal["rfc822", "gmail_raw", "gmail_full"]
    fetched_at: datetime

    # Optional common fields
    provider_thread_id: str | None = None
    raw_payload: str | None = None  # Base64 for small messages
    size_bytes: int | None = None
    content_hash: str | None = None
    attachments_manifest: list[AttachmentManifestItem] = field(default_factory=list)
    headers_subset: dict[str, Any] | None = None

    # Gmail-specific
    gmail_metadata: dict[str, Any] | None = None

    # IMAP-specific
    imap_metadata: dict[str, Any] | None = None

    def to_payload(self) -> dict[str, Any]:
        """Convert to Kafka payload dict."""
        payload: dict[str, Any] = {
            "provider_message_id": self.provider_message_id,
            "email_id": self.email_id,
            "internal_date": self.received_at.isoformat(),  # TS contract field name
            "raw_object_uri": self.raw_object_uri,
            "raw_format": self.raw_format,
            "fetched_at": self.fetched_at.isoformat(),
        }

        if self.provider_thread_id:
            payload["thread_id"] = self.provider_thread_id  # TS contract field name

        if self.raw_payload:
            payload["raw_payload"] = self.raw_payload

        if self.size_bytes is not None:
            payload["size_bytes"] = self.size_bytes

        if self.content_hash:
            payload["content_hash"] = self.content_hash

        if self.attachments_manifest:
            payload["attachments_manifest"] = [
                {
                    "attachment_id": a.attachment_id,
                    "filename": a.filename,
                    "content_type": a.content_type,
                    "size_bytes": a.size_bytes,
                    **({"object_uri": a.object_uri} if a.object_uri else {}),
                }
                for a in self.attachments_manifest
            ]

        if self.headers_subset:
            payload["headers_subset"] = self.headers_subset

        if self.gmail_metadata:
            payload["gmail_metadata"] = self.gmail_metadata

        if self.imap_metadata:
            payload["imap_metadata"] = self.imap_metadata

        return payload


def build_envelope(
    tenant_id: str,
    account_id: str,
    alias: str,
    provider: Literal["gmail", "imap"],
    provider_message_id: str,
    scope: str | None = None,
    provider_thread_id: str | None = None,
    service_name: str = "mail-ingestion",
    service_version: str = "0.1.0",
) -> dict[str, Any]:
    """
    Build Kafka envelope for a raw mail event.

    Args:
        tenant_id: Tenant identifier
        account_id: Account identifier
        alias: Stable logical label for routing
        provider: Mail provider
        provider_message_id: Provider-specific message ID
        scope: Scope (Gmail label/query, IMAP folder)
        provider_thread_id: Provider thread ID (Gmail only)
        service_name: Producing service name
        service_version: Producing service version

    Returns:
        A dict conforming to lattice.envelope.v1 schema.
    """
    now = datetime.now(UTC)

    envelope: dict[str, Any] = {
        "message_id": str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "account_id": account_id,
        "alias": alias,
        "domain": "mail",
        "stage": "raw",
        "schema_version": "v1",
        "created_at": now.isoformat(),
        "source": {
            "service": service_name,
            "version": service_version,
        },
        "provider_source": {
            "provider": provider,
            "account_id": account_id,
            "alias": alias,
            "provider_message_id": provider_message_id,
        },
        "data_classification": "confidential",
        "pii": {
            "contains_pii": True,
            "pii_fields": ["payload.headers_subset", "payload.raw_object_uri"],
        },
    }

    if scope:
        envelope["provider_source"]["scope"] = scope

    if provider_thread_id:
        envelope["provider_source"]["provider_thread_id"] = provider_thread_id

    return envelope


def build_raw_event(
    tenant_id: str,
    account_id: str,
    alias: str,
    provider: Literal["gmail", "imap"],
    provider_message_id: str,
    raw_bytes: bytes,
    raw_object_uri: str,
    received_at: datetime,
    fetched_at: datetime | None = None,
    provider_thread_id: str | None = None,
    scope: str | None = None,
    gmail_metadata: dict[str, Any] | None = None,
    imap_metadata: dict[str, Any] | None = None,
    attachments_manifest: list[AttachmentManifestItem] | None = None,
    service_name: str = "mail-ingestion",
    service_version: str = "0.1.0",
) -> dict[str, Any]:
    """
    Build complete Kafka message (envelope + payload) for lattice.mail.raw.v1.

    Args:
        tenant_id: Tenant identifier
        account_id: Account identifier (logical mailbox)
        alias: Stable logical label for routing (used in object storage path)
        provider: Mail provider ('gmail' or 'imap')
        provider_message_id: Provider-specific message ID
        raw_bytes: Raw RFC822 message bytes
        raw_object_uri: Object storage URI where raw message is stored
        received_at: When the email was received by mail server
        fetched_at: When the message was fetched (defaults to now)
        provider_thread_id: Provider thread ID (Gmail only)
        scope: Scope (Gmail label/query, IMAP folder)
        gmail_metadata: Gmail-specific metadata
        imap_metadata: IMAP-specific metadata
        attachments_manifest: List of attachment metadata
        service_name: Producing service name
        service_version: Producing service version

    Returns:
        Complete Kafka message dict with envelope and payload

    Raises:
        ValueError: If email size exceeds MAX_EMAIL_SIZE_BYTES (25 MB)
    """
    if fetched_at is None:
        fetched_at = datetime.now(UTC)

    raw_size = len(raw_bytes)

    # Reject oversized emails
    if raw_size > MAX_EMAIL_SIZE_BYTES:
        raise ValueError(
            f"Email size {raw_size:,} bytes exceeds maximum {MAX_EMAIL_SIZE_BYTES:,} bytes"
        )

    # Generate deterministic email_id from content hash
    content_hash = hashlib.sha256(raw_bytes).hexdigest()
    email_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"lattice:{tenant_id}:{content_hash}"))

    # Determine raw format
    raw_format: Literal["rfc822", "gmail_raw", "gmail_full"] = (
        "gmail_raw" if provider == "gmail" else "rfc822"
    )

    # Build event - raw_object_uri is ALWAYS set (provided by caller)
    event = RawMailEvent(
        provider_message_id=provider_message_id,
        email_id=email_id,
        received_at=received_at,
        raw_object_uri=raw_object_uri,
        raw_format=raw_format,
        fetched_at=fetched_at,
        provider_thread_id=provider_thread_id,
        size_bytes=raw_size,
        content_hash=content_hash,
        attachments_manifest=attachments_manifest or [],
        gmail_metadata=gmail_metadata,
        imap_metadata=imap_metadata,
    )

    # CLAIM CHECK PATTERN: Only inline payload if under threshold
    # For large emails (> 256 KB), parser will fetch from raw_object_uri
    if raw_size <= INLINE_THRESHOLD_BYTES:
        event.raw_payload = base64.urlsafe_b64encode(raw_bytes).decode("ascii")

    # Build envelope
    envelope = build_envelope(
        tenant_id=tenant_id,
        account_id=account_id,
        alias=alias,
        provider=provider,
        provider_message_id=provider_message_id,
        scope=scope,
        provider_thread_id=provider_thread_id,
        service_name=service_name,
        service_version=service_version,
    )

    # Combine envelope and payload
    envelope["payload"] = event.to_payload()

    return envelope
