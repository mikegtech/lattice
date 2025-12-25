"""
Shared Airflow task functions for Lattice mail sync DAGs.

This module contains the actual processing logic used by the DAGs.
It imports from lattice_* libraries and handles:
- Account loading from Postgres
- Message fetching from Gmail/IMAP
- Object storage uploads
- Kafka publishing
- Post-processing (labeling/moving)
- Watermark updates
"""

import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

logger = logging.getLogger(__name__)


@dataclass
class SyncResult:
    """Result of a sync operation for a single account."""

    account_id: str
    alias: str
    messages_fetched: int
    messages_stored: int
    messages_published: int
    messages_post_processed: int
    errors: list[str]
    watermark_updated: bool


def get_env(name: str, default: str = "") -> str:
    """Get environment variable with default."""
    return os.getenv(name, default)


def load_enabled_accounts(
    provider: Literal["gmail", "imap"],
    tenant_id: str | None = None,
) -> list[dict[str, Any]]:
    """
    Load enabled accounts from Postgres.

    Returns list of account dicts with keys:
        tenant_id, account_id, alias, provider, config_json, source_folder
    """
    # Import here to avoid import errors when Airflow parses DAG files
    from lattice_mail.account_registry import AccountRegistry, PostgresConfig

    pg_config = PostgresConfig.from_env()
    registry = AccountRegistry(pg_config)

    accounts = registry.list_enabled_accounts(provider=provider, tenant_id=tenant_id)

    return [
        {
            "tenant_id": a.tenant_id,
            "account_id": a.account_id,
            "alias": a.alias,
            "provider": a.provider,
            "config_json": a.config_json,
            "source_folder": a.source_folder,
        }
        for a in accounts
    ]


def process_gmail_account_incremental(
    tenant_id: str,
    account_id: str,
    alias: str,
    max_messages: int = 100,
) -> SyncResult:
    """
    Process a single Gmail account incrementally.

    Steps:
    1. Load watermark (historyId)
    2. Fetch new messages via history API or query
    3. For each message: store to MinIO, publish to Kafka
    4. Apply alias label to message
    5. Update watermark only after all steps succeed
    """
    from lattice_kafka import KafkaProducer, KafkaProducerConfig
    from lattice_kafka.producer import TOPIC_MAIL_RAW
    from lattice_mail.account_registry import PostgresConfig
    from lattice_mail.connectors.gmail_connector import GmailConfig, GmailConnector
    from lattice_mail.raw_event import AttachmentManifestItem, build_raw_event
    from lattice_mail.watermarks import WatermarkStore
    from lattice_storage import ObjectStore, ObjectStoreConfig
    from lattice_storage.object_store import build_message_key

    result = SyncResult(
        account_id=account_id,
        alias=alias,
        messages_fetched=0,
        messages_stored=0,
        messages_published=0,
        messages_post_processed=0,
        errors=[],
        watermark_updated=False,
    )

    # Initialize services
    pg_config = PostgresConfig.from_env()
    watermark_store = WatermarkStore(pg_config)
    storage_config = ObjectStoreConfig.from_env()
    object_store = ObjectStore(storage_config)
    object_store.ensure_bucket()

    kafka_config = KafkaProducerConfig.from_env()
    producer = KafkaProducer(kafka_config) if kafka_config.bootstrap_servers else None

    # Initialize Gmail connector
    gmail_config = GmailConfig(
        client_id=get_env("GMAIL_CLIENT_ID"),
        client_secret=get_env("GMAIL_CLIENT_SECRET"),
        refresh_token=get_env("GMAIL_REFRESH_TOKEN"),
        user_email=get_env("GMAIL_USER_EMAIL", "me"),
    )
    gmail = GmailConnector(gmail_config)

    # Get current profile for historyId
    profile = gmail.get_profile()
    current_history_id = profile.get("historyId", "")
    scope = "INBOX"

    # Get existing watermark
    existing = watermark_store.get_watermark(tenant_id, account_id, "gmail", scope)

    # Decide fetch strategy
    message_ids: list[str] = []
    if existing:
        existing_wm = existing.as_gmail()
        try:
            message_ids, _ = gmail.list_history(
                existing_wm.history_id,
                max_results=max_messages,
            )
            logger.info("History sync: found %d new messages", len(message_ids))
        except Exception as e:
            # History may be stale, fall back to query
            logger.warning("History API failed, falling back to query: %s", e)
            # Exclude already processed messages (those labeled with Lattice/<alias>)
            exclusion_label = f"Lattice/{alias}"
            query = f"newer_than:1d -label:{exclusion_label}"
            message_ids, _ = gmail.list_message_ids_by_query(query, max_results=max_messages)
    else:
        # No watermark - initial sync via query
        message_ids, _ = gmail.list_message_ids_by_query(
            "newer_than:7d",
            max_results=max_messages,
        )
        logger.info("Initial sync: found %d messages", len(message_ids))

    # Process each message
    for msg_id in message_ids:
        try:
            # 1. Fetch raw message
            msg = gmail.get_message_raw(msg_id)
            result.messages_fetched += 1

            # 2. Store to object storage
            key = build_message_key(
                tenant_id=tenant_id,
                account_id=account_id,
                alias=alias,
                provider="gmail",
                provider_message_id=msg.message_id,
            )
            uri = object_store.put_bytes(
                key=key,
                data=msg.raw_bytes,
                content_type="message/rfc822",
            )
            result.messages_stored += 1

            # 3. Get attachments manifest
            attachments = gmail.list_attachments(msg.message_id)
            manifest = [
                AttachmentManifestItem(
                    attachment_id=a.attachment_id,
                    filename=a.filename,
                    content_type=a.mime_type,
                    size_bytes=a.size_bytes,
                )
                for a in attachments
            ]

            # 4. Publish to Kafka
            if producer:
                event = build_raw_event(
                    tenant_id=tenant_id,
                    account_id=account_id,
                    alias=alias,
                    provider="gmail",
                    provider_message_id=msg.message_id,
                    raw_bytes=msg.raw_bytes,
                    raw_object_uri=uri,
                    received_at=msg.internal_date,
                    provider_thread_id=msg.thread_id,
                    scope=scope,
                    gmail_metadata={
                        "history_id": msg.history_id,
                        "label_ids": msg.label_ids,
                        "internal_date": msg.internal_date.isoformat(),
                    },
                    attachments_manifest=manifest,
                )
                producer.publish(
                    topic=TOPIC_MAIL_RAW,
                    key=msg.message_id,
                    value=event,
                    headers={"provider": "gmail", "tenant_id": tenant_id, "alias": alias},
                )
                result.messages_published += 1

            # 5. Apply alias label (post-processing)
            gmail.apply_alias_label(msg.message_id, alias)
            result.messages_post_processed += 1

        except Exception as e:
            result.errors.append(f"Message {msg_id}: {e}")
            logger.exception("Failed to process Gmail message")

    # Flush Kafka
    if producer:
        producer.flush()

    # Update watermark only if we had no critical errors
    if result.messages_fetched > 0 and len(result.errors) < result.messages_fetched:
        watermark_store.upsert_gmail_watermark(
            tenant_id=tenant_id,
            account_id=account_id,
            scope=scope,
            history_id=current_history_id,
        )
        result.watermark_updated = True

    logger.info(
        "Gmail sync complete: %d fetched, %d stored, %d published, %d post-processed",
        result.messages_fetched,
        result.messages_stored,
        result.messages_published,
        result.messages_post_processed,
    )
    return result


def process_imap_account_incremental(
    tenant_id: str,
    account_id: str,
    alias: str,
    source_folder: str = "INBOX",
    max_messages: int = 100,
) -> SyncResult:
    """
    Process a single IMAP account incrementally.

    Steps:
    1. Load watermark (uidvalidity, last_uid)
    2. Fetch new messages since last_uid
    3. For each message: store to MinIO, publish to Kafka
    4. Move message to alias folder
    5. Update watermark only after all steps succeed
    """
    from lattice_kafka import KafkaProducer, KafkaProducerConfig
    from lattice_kafka.producer import TOPIC_MAIL_RAW
    from lattice_mail.account_registry import PostgresConfig
    from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector
    from lattice_mail.raw_event import AttachmentManifestItem, build_raw_event
    from lattice_mail.watermarks import WatermarkStore
    from lattice_storage import ObjectStore, ObjectStoreConfig
    from lattice_storage.object_store import build_message_key

    result = SyncResult(
        account_id=account_id,
        alias=alias,
        messages_fetched=0,
        messages_stored=0,
        messages_published=0,
        messages_post_processed=0,
        errors=[],
        watermark_updated=False,
    )

    # Initialize services
    pg_config = PostgresConfig.from_env()
    watermark_store = WatermarkStore(pg_config)
    storage_config = ObjectStoreConfig.from_env()
    object_store = ObjectStore(storage_config)
    object_store.ensure_bucket()

    kafka_config = KafkaProducerConfig.from_env()
    producer = KafkaProducer(kafka_config) if kafka_config.bootstrap_servers else None

    # Initialize IMAP connector
    imap_config = ImapConfig(
        host=get_env("IMAP_HOST"),
        port=int(get_env("IMAP_PORT", "993")),
        username=get_env("IMAP_USERNAME"),
        password=get_env("IMAP_PASSWORD"),
    )

    with ImapConnector(imap_config) as imap:
        # Get existing watermark
        existing = watermark_store.get_watermark(tenant_id, account_id, "imap", source_folder)

        # Get current UIDVALIDITY
        uidvalidity = imap.select_folder(source_folder)

        # Determine starting point
        since_uid = 0
        if existing:
            existing_wm = existing.as_imap()
            if existing_wm.uidvalidity == uidvalidity:
                since_uid = existing_wm.last_uid
                logger.info("Resuming from UID %d", since_uid)
            else:
                logger.warning(
                    "UIDVALIDITY changed (%d -> %d), resetting watermark",
                    existing_wm.uidvalidity,
                    uidvalidity,
                )

        # List UIDs to fetch
        uids, _ = imap.list_uids_since(source_folder, since_uid, limit=max_messages)
        logger.info("Found %d new messages in %s", len(uids), source_folder)

        newest_uid = since_uid
        last_success_uid = since_uid

        for uid in uids:
            try:
                # 1. Fetch message
                msg = imap.fetch_message(source_folder, uid)
                result.messages_fetched += 1
                newest_uid = max(newest_uid, uid)

                # 2. Store to object storage
                key = build_message_key(
                    tenant_id=tenant_id,
                    account_id=account_id,
                    alias=alias,
                    provider="imap",
                    provider_message_id=msg.provider_message_id,
                )
                uri = object_store.put_bytes(
                    key=key,
                    data=msg.raw_bytes,
                    content_type="message/rfc822",
                )
                result.messages_stored += 1

                # 3. Extract attachment metadata
                attachments = imap.extract_attachments_metadata(msg.raw_bytes, uid)
                manifest = [
                    AttachmentManifestItem(
                        attachment_id=a.attachment_id,
                        filename=a.filename,
                        content_type=a.content_type,
                        size_bytes=a.size_bytes,
                    )
                    for a in attachments
                ]

                # 4. Publish to Kafka
                if producer:
                    event = build_raw_event(
                        tenant_id=tenant_id,
                        account_id=account_id,
                        alias=alias,
                        provider="imap",
                        provider_message_id=msg.provider_message_id,
                        raw_bytes=msg.raw_bytes,
                        raw_object_uri=uri,
                        received_at=msg.internal_date,
                        scope=source_folder,
                        imap_metadata={
                            "uid": msg.uid,
                            "uidvalidity": msg.uidvalidity,
                            "folder": msg.folder,
                            "flags": msg.flags,
                        },
                        attachments_manifest=manifest,
                    )
                    producer.publish(
                        topic=TOPIC_MAIL_RAW,
                        key=msg.provider_message_id,
                        value=event,
                        headers={"provider": "imap", "tenant_id": tenant_id, "alias": alias},
                    )
                    result.messages_published += 1

                # 5. Move to alias folder (post-processing)
                imap.move_to_alias_folder(source_folder, uid, alias)
                result.messages_post_processed += 1

                # Advance watermark only past messages that completed post-processing
                last_success_uid = max(last_success_uid, uid)

            except Exception as e:
                result.errors.append(f"UID {uid}: {e}")
                logger.exception("Failed to process IMAP message")

        # Flush Kafka
        if producer:
            producer.flush()

        # Update watermark ONLY to the highest UID that fully succeeded (store+publish+post-process)
        if last_success_uid > since_uid:
            watermark_store.upsert_imap_watermark(
                tenant_id=tenant_id,
                account_id=account_id,
                scope=source_folder,
                uidvalidity=uidvalidity,
                last_uid=last_success_uid,
            )
            result.watermark_updated = True

    logger.info(
        "IMAP sync complete: %d fetched, %d stored, %d published, %d post-processed",
        result.messages_fetched,
        result.messages_stored,
        result.messages_published,
        result.messages_post_processed,
    )
    return result


def process_gmail_backfill(
    tenant_id: str,
    account_id: str,
    alias: str,
    start_date: datetime,
    end_date: datetime,
    limit_per_run: int = 100,
) -> SyncResult:
    """
    Backfill Gmail messages within a date range.

    Uses date-based query to fetch historical messages.
    Does NOT update the regular watermark - backfill is separate.
    """
    from lattice_kafka import KafkaProducer, KafkaProducerConfig
    from lattice_kafka.producer import TOPIC_MAIL_RAW
    from lattice_mail.connectors.gmail_connector import GmailConfig, GmailConnector
    from lattice_mail.raw_event import AttachmentManifestItem, build_raw_event
    from lattice_storage import ObjectStore, ObjectStoreConfig
    from lattice_storage.object_store import build_message_key

    result = SyncResult(
        account_id=account_id,
        alias=alias,
        messages_fetched=0,
        messages_stored=0,
        messages_published=0,
        messages_post_processed=0,
        errors=[],
        watermark_updated=False,
    )

    # Initialize services
    storage_config = ObjectStoreConfig.from_env()
    object_store = ObjectStore(storage_config)
    object_store.ensure_bucket()

    kafka_config = KafkaProducerConfig.from_env()
    producer = KafkaProducer(kafka_config) if kafka_config.bootstrap_servers else None

    # Initialize Gmail connector
    gmail_config = GmailConfig(
        client_id=get_env("GMAIL_CLIENT_ID"),
        client_secret=get_env("GMAIL_CLIENT_SECRET"),
        refresh_token=get_env("GMAIL_REFRESH_TOKEN"),
        user_email=get_env("GMAIL_USER_EMAIL", "me"),
    )
    gmail = GmailConnector(gmail_config)

    # Build date-based query
    after_str = start_date.strftime("%Y/%m/%d")
    before_str = end_date.strftime("%Y/%m/%d")
    query = f"after:{after_str} before:{before_str}"

    logger.info("Backfill query: %s (limit: %d)", query, limit_per_run)

    # List messages
    message_ids, _ = gmail.list_message_ids_by_query(query, max_results=limit_per_run)
    scope = "INBOX"

    for msg_id in message_ids:
        try:
            # Check if already labeled (idempotency)
            label_name = f"Lattice/{alias}"
            if gmail.has_label(msg_id, label_name):
                logger.debug("Message already processed, skipping")
                continue

            # Fetch, store, publish, label
            msg = gmail.get_message_raw(msg_id)
            result.messages_fetched += 1

            key = build_message_key(
                tenant_id=tenant_id,
                account_id=account_id,
                alias=alias,
                provider="gmail",
                provider_message_id=msg.message_id,
            )
            uri = object_store.put_bytes(
                key=key,
                data=msg.raw_bytes,
                content_type="message/rfc822",
            )
            result.messages_stored += 1

            attachments = gmail.list_attachments(msg.message_id)
            manifest = [
                AttachmentManifestItem(
                    attachment_id=a.attachment_id,
                    filename=a.filename,
                    content_type=a.mime_type,
                    size_bytes=a.size_bytes,
                )
                for a in attachments
            ]

            if producer:
                event = build_raw_event(
                    tenant_id=tenant_id,
                    account_id=account_id,
                    alias=alias,
                    provider="gmail",
                    provider_message_id=msg.message_id,
                    raw_bytes=msg.raw_bytes,
                    raw_object_uri=uri,
                    received_at=msg.internal_date,
                    provider_thread_id=msg.thread_id,
                    scope=scope,
                    gmail_metadata={
                        "history_id": msg.history_id,
                        "label_ids": msg.label_ids,
                        "internal_date": msg.internal_date.isoformat(),
                        "backfill": True,
                    },
                    attachments_manifest=manifest,
                )
                producer.publish(
                    topic=TOPIC_MAIL_RAW,
                    key=msg.message_id,
                    value=event,
                    headers={"provider": "gmail", "tenant_id": tenant_id, "alias": alias},
                )
                result.messages_published += 1

            gmail.apply_alias_label(msg.message_id, alias)
            result.messages_post_processed += 1

        except Exception as e:
            result.errors.append(f"Message {msg_id}: {e}")
            logger.exception("Failed to process Gmail backfill message")

    if producer:
        producer.flush()

    logger.info(
        "Gmail backfill complete: %d fetched, %d stored, %d published, %d labeled",
        result.messages_fetched,
        result.messages_stored,
        result.messages_published,
        result.messages_post_processed,
    )
    return result


def process_imap_backfill(
    tenant_id: str,
    account_id: str,
    alias: str,
    source_folder: str,
    start_date: datetime,
    end_date: datetime,
    limit_per_run: int = 100,
) -> SyncResult:
    """
    Backfill IMAP messages from a folder.

    For IMAP, we can't easily query by date, so we process all unprocessed
    messages (those still in source_folder that haven't been moved).
    The date range is for logging/metadata purposes.
    """
    from lattice_kafka import KafkaProducer, KafkaProducerConfig
    from lattice_kafka.producer import TOPIC_MAIL_RAW
    from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector
    from lattice_mail.raw_event import AttachmentManifestItem, build_raw_event
    from lattice_storage import ObjectStore, ObjectStoreConfig
    from lattice_storage.object_store import build_message_key

    result = SyncResult(
        account_id=account_id,
        alias=alias,
        messages_fetched=0,
        messages_stored=0,
        messages_published=0,
        messages_post_processed=0,
        errors=[],
        watermark_updated=False,
    )

    # Initialize services
    storage_config = ObjectStoreConfig.from_env()
    object_store = ObjectStore(storage_config)
    object_store.ensure_bucket()

    kafka_config = KafkaProducerConfig.from_env()
    producer = KafkaProducer(kafka_config) if kafka_config.bootstrap_servers else None

    imap_config = ImapConfig(
        host=get_env("IMAP_HOST"),
        port=int(get_env("IMAP_PORT", "993")),
        username=get_env("IMAP_USERNAME"),
        password=get_env("IMAP_PASSWORD"),
    )

    with ImapConnector(imap_config) as imap:
        # List all messages in source folder (they're unprocessed)
        uids, uidvalidity = imap.list_uids_since(source_folder, 0, limit=limit_per_run)
        logger.info(
            "IMAP backfill: found %d messages in %s (date range: %s to %s)",
            len(uids),
            source_folder,
            start_date.isoformat(),
            end_date.isoformat(),
        )

        for uid in uids:
            try:
                msg = imap.fetch_message(source_folder, uid)

                # Check if message is within date range
                if msg.internal_date < start_date or msg.internal_date > end_date:
                    logger.debug("Message outside date range, skipping")
                    continue

                result.messages_fetched += 1

                key = build_message_key(
                    tenant_id=tenant_id,
                    account_id=account_id,
                    alias=alias,
                    provider="imap",
                    provider_message_id=msg.provider_message_id,
                )
                uri = object_store.put_bytes(
                    key=key,
                    data=msg.raw_bytes,
                    content_type="message/rfc822",
                )
                result.messages_stored += 1

                attachments = imap.extract_attachments_metadata(msg.raw_bytes, uid)
                manifest = [
                    AttachmentManifestItem(
                        attachment_id=a.attachment_id,
                        filename=a.filename,
                        content_type=a.content_type,
                        size_bytes=a.size_bytes,
                    )
                    for a in attachments
                ]

                if producer:
                    event = build_raw_event(
                        tenant_id=tenant_id,
                        account_id=account_id,
                        alias=alias,
                        provider="imap",
                        provider_message_id=msg.provider_message_id,
                        raw_bytes=msg.raw_bytes,
                        raw_object_uri=uri,
                        received_at=msg.internal_date,
                        scope=source_folder,
                        imap_metadata={
                            "uid": msg.uid,
                            "uidvalidity": msg.uidvalidity,
                            "folder": msg.folder,
                            "flags": msg.flags,
                            "backfill": True,
                        },
                        attachments_manifest=manifest,
                    )
                    producer.publish(
                        topic=TOPIC_MAIL_RAW,
                        key=msg.provider_message_id,
                        value=event,
                        headers={"provider": "imap", "tenant_id": tenant_id, "alias": alias},
                    )
                    result.messages_published += 1

                imap.move_to_alias_folder(source_folder, uid, alias)
                result.messages_post_processed += 1

            except Exception as e:
                result.errors.append(f"UID {uid}: {e}")
                logger.exception("Failed to process IMAP backfill message")

        if producer:
            producer.flush()

    logger.info(
        "IMAP backfill complete: %d fetched, %d stored, %d published, %d moved",
        result.messages_fetched,
        result.messages_stored,
        result.messages_published,
        result.messages_post_processed,
    )
    return result
