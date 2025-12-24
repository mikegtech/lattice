#!/usr/bin/env python3
"""
Demo script: Fetch messages from Gmail and WorkMail IMAP inboxes.

This script demonstrates the Phase 2 multi-provider ingestion by:
1. Seeding mail_accounts in Postgres
2. Fetching messages from Gmail API and IMAP
3. Storing raw .eml files to MinIO
4. Publishing lattice.mail.raw.v1 events to Kafka

Environment variables required:
    # Postgres
    POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD

    # MinIO/S3
    MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, STORAGE_BUCKET

    # Kafka (Confluent Cloud)
    KAFKA_BOOTSTRAP_SERVERS, KAFKA_SASL_USERNAME, KAFKA_SASL_PASSWORD

    # Gmail OAuth
    GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER_EMAIL

    # IMAP (WorkMail)
    IMAP_HOST, IMAP_USERNAME, IMAP_PASSWORD, IMAP_FOLDERS (comma-separated)

    # Account identifiers
    TENANT_ID (default: personal)
    GMAIL_ACCOUNT_ID (default: personal-gmail)
    IMAP_ACCOUNT_ID (default: workmail-imap)

Usage:
    python -m scripts.demo_fetch_two_inboxes
"""

import logging
import os
import sys

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def get_env(name: str, default: str | None = None, required: bool = False) -> str:
    """Get environment variable with optional default."""
    value = os.getenv(name, default)
    if required and not value:
        raise ValueError(f"Required environment variable {name} is not set")
    return value or ""


def main() -> int:
    """Main entry point."""
    logger.info("=" * 60)
    logger.info("Lattice Two-Inbox Demo")
    logger.info("=" * 60)

    # Import after path setup
    from lattice_kafka import KafkaProducer, KafkaProducerConfig
    from lattice_kafka.producer import TOPIC_MAIL_RAW
    from lattice_mail.account_registry import AccountRegistry, PostgresConfig
    from lattice_mail.connectors import GmailConnector, ImapConnector
    from lattice_mail.connectors.gmail_connector import GmailConfig
    from lattice_mail.connectors.imap_connector import ImapConfig
    from lattice_mail.raw_event import AttachmentManifestItem, build_raw_event
    from lattice_mail.watermarks import WatermarkStore
    from lattice_storage import ObjectStore, ObjectStoreConfig
    from lattice_storage.object_store import build_message_key

    # Configuration
    tenant_id = get_env("TENANT_ID", "personal")
    gmail_account_id = get_env("GMAIL_ACCOUNT_ID", "personal-gmail")
    gmail_alias = get_env("GMAIL_ALIAS", "personal-gmail")
    imap_account_id = get_env("IMAP_ACCOUNT_ID", "workmail-imap")
    imap_alias = get_env("IMAP_ALIAS", "workmail-processed")
    max_messages = int(get_env("MAX_MESSAGES", "10"))

    # Check which providers are configured
    gmail_enabled = bool(get_env("GMAIL_REFRESH_TOKEN"))
    imap_enabled = bool(get_env("IMAP_HOST"))

    if not gmail_enabled and not imap_enabled:
        logger.error("No providers configured. Set GMAIL_REFRESH_TOKEN or IMAP_HOST.")
        return 1

    # Initialize Postgres connection
    pg_config = PostgresConfig.from_env()
    account_registry = AccountRegistry(pg_config)
    watermark_store = WatermarkStore(pg_config)

    # Initialize object storage
    storage_config = ObjectStoreConfig.from_env()
    object_store = ObjectStore(storage_config)
    object_store.ensure_bucket()
    logger.info("Storage bucket ready: %s", storage_config.default_bucket)

    # Initialize Kafka producer
    kafka_config = KafkaProducerConfig.from_env()
    kafka_enabled = bool(kafka_config.bootstrap_servers)
    producer: KafkaProducer | None = None
    if kafka_enabled:
        producer = KafkaProducer(kafka_config)
        logger.info("Kafka producer ready: %s", kafka_config.bootstrap_servers)
    else:
        logger.warning("Kafka not configured, skipping event publishing")

    # Statistics
    stats = {
        "gmail_messages": 0,
        "gmail_stored": 0,
        "gmail_published": 0,
        "imap_messages": 0,
        "imap_stored": 0,
        "imap_published": 0,
    }

    # =========================================================================
    # Gmail Processing
    # =========================================================================
    if gmail_enabled:
        logger.info("-" * 40)
        logger.info("Processing Gmail account: %s", gmail_account_id)
        logger.info("-" * 40)

        try:
            gmail_config = GmailConfig(
                client_id=get_env("GMAIL_CLIENT_ID", required=True),
                client_secret=get_env("GMAIL_CLIENT_SECRET", required=True),
                refresh_token=get_env("GMAIL_REFRESH_TOKEN", required=True),
                user_email=get_env("GMAIL_USER_EMAIL", "me"),
            )

            # Seed account
            account_registry.upsert_account(
                tenant_id=tenant_id,
                account_id=gmail_account_id,
                alias=gmail_alias,
                provider="gmail",
                config_json={"email": gmail_config.user_email, "scopes": ["INBOX"]},
            )

            gmail = GmailConnector(gmail_config)

            # Get profile for history ID
            profile = gmail.get_profile()
            current_history_id = profile.get("historyId", "")
            logger.info("Gmail profile: historyId=%s", current_history_id)

            # List messages (demo: last N by query)
            scope = "INBOX"
            query = "newer_than:7d"
            message_ids, _ = gmail.list_message_ids_by_query(query, max_results=max_messages)
            logger.info("Found %d messages matching query: %s", len(message_ids), query)

            for msg_id in message_ids:
                try:
                    # Fetch raw message
                    msg = gmail.get_message_raw(msg_id)
                    stats["gmail_messages"] += 1

                    # Store to MinIO
                    key = build_message_key(
                        tenant_id=tenant_id,
                        account_id=gmail_account_id,
                        alias=gmail_alias,
                        provider="gmail",
                        provider_message_id=msg.message_id,
                    )
                    uri = object_store.put_bytes(
                        key=key,
                        data=msg.raw_bytes,
                        content_type="message/rfc822",
                    )
                    stats["gmail_stored"] += 1
                    logger.debug("Stored message %s to %s", msg.message_id, uri)

                    # Get attachments manifest
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

                    # Build and publish event
                    if producer:
                        event = build_raw_event(
                            tenant_id=tenant_id,
                            account_id=gmail_account_id,
                            alias=gmail_alias,
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
                            headers={
                                "provider": "gmail",
                                "tenant_id": tenant_id,
                                "alias": gmail_alias,
                            },
                        )
                        stats["gmail_published"] += 1

                    # Apply alias label (post-processing)
                    gmail.apply_alias_label(msg.message_id, gmail_alias)

                except Exception as e:
                    logger.error("Failed to process Gmail message %s: %s", msg_id, e)

            # Update watermark
            if current_history_id:
                watermark_store.upsert_gmail_watermark(
                    tenant_id=tenant_id,
                    account_id=gmail_account_id,
                    scope=scope,
                    history_id=current_history_id,
                )
                logger.info("Updated Gmail watermark: historyId=%s", current_history_id)

        except Exception as e:
            logger.error("Gmail processing failed: %s", e)

    # =========================================================================
    # IMAP Processing
    # =========================================================================
    if imap_enabled:
        logger.info("-" * 40)
        logger.info("Processing IMAP account: %s", imap_account_id)
        logger.info("-" * 40)

        try:
            folders_str = get_env("IMAP_FOLDERS", "INBOX")
            folders = [f.strip() for f in folders_str.split(",")]

            imap_config = ImapConfig(
                host=get_env("IMAP_HOST", required=True),
                port=int(get_env("IMAP_PORT", "993")),
                username=get_env("IMAP_USERNAME", required=True),
                password=get_env("IMAP_PASSWORD", required=True),
                folders=folders,
            )

            # Seed account
            account_registry.upsert_account(
                tenant_id=tenant_id,
                account_id=imap_account_id,
                alias=imap_alias,
                provider="imap",
                config_json={
                    "host": imap_config.host,
                    "port": imap_config.port,
                    "folders": imap_config.folders,
                },
            )

            with ImapConnector(imap_config) as imap:
                for folder in folders:
                    logger.info("Processing IMAP folder: %s", folder)

                    # Get existing watermark
                    existing = watermark_store.get_watermark(
                        tenant_id=tenant_id,
                        account_id=imap_account_id,
                        provider="imap",
                        scope=folder,
                    )

                    # Get current UIDVALIDITY
                    uidvalidity = imap.select_folder(folder)

                    # Check for UIDVALIDITY change
                    since_uid = 0
                    if existing:
                        existing_wm = existing.as_imap()
                        if existing_wm.uidvalidity == uidvalidity:
                            since_uid = existing_wm.last_uid
                            logger.info(
                                "Resuming from UID %d (UIDVALIDITY=%d)",
                                since_uid,
                                uidvalidity,
                            )
                        else:
                            logger.warning(
                                "UIDVALIDITY changed (%d -> %d), resetting watermark",
                                existing_wm.uidvalidity,
                                uidvalidity,
                            )
                    else:
                        # No existing watermark - get latest UID and work backwards
                        latest = imap.get_latest_uid(folder)
                        if latest > max_messages:
                            since_uid = latest - max_messages
                        logger.info(
                            "No watermark, starting from UID %d (latest=%d)",
                            since_uid,
                            latest,
                        )

                    # List UIDs to fetch
                    uids, _ = imap.list_uids_since(folder, since_uid, limit=max_messages)
                    logger.info("Found %d new messages in %s", len(uids), folder)

                    newest_uid = since_uid
                    for uid in uids:
                        try:
                            # Fetch message
                            msg = imap.fetch_message(folder, uid)
                            stats["imap_messages"] += 1
                            newest_uid = max(newest_uid, uid)

                            # Store to MinIO
                            key = build_message_key(
                                tenant_id=tenant_id,
                                account_id=imap_account_id,
                                alias=imap_alias,
                                provider="imap",
                                provider_message_id=msg.provider_message_id,
                            )
                            uri = object_store.put_bytes(
                                key=key,
                                data=msg.raw_bytes,
                                content_type="message/rfc822",
                            )
                            stats["imap_stored"] += 1
                            logger.debug("Stored message %s to %s", msg.provider_message_id, uri)

                            # Extract attachment metadata (best effort)
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

                            # Build and publish event
                            if producer:
                                event = build_raw_event(
                                    tenant_id=tenant_id,
                                    account_id=imap_account_id,
                                    alias=imap_alias,
                                    provider="imap",
                                    provider_message_id=msg.provider_message_id,
                                    raw_bytes=msg.raw_bytes,
                                    raw_object_uri=uri,
                                    received_at=msg.internal_date,
                                    scope=folder,
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
                                    headers={
                                        "provider": "imap",
                                        "tenant_id": tenant_id,
                                        "alias": imap_alias,
                                    },
                                )
                                stats["imap_published"] += 1

                            # Move to alias folder (post-processing)
                            imap.move_to_alias_folder(folder, uid, imap_alias)

                        except Exception as e:
                            logger.error("Failed to process IMAP message UID %d: %s", uid, e)

                    # Update watermark
                    if newest_uid > 0:
                        watermark_store.upsert_imap_watermark(
                            tenant_id=tenant_id,
                            account_id=imap_account_id,
                            scope=folder,
                            uidvalidity=uidvalidity,
                            last_uid=newest_uid,
                        )
                        logger.info(
                            "Updated IMAP watermark: folder=%s, uidvalidity=%d, last_uid=%d",
                            folder,
                            uidvalidity,
                            newest_uid,
                        )

        except Exception as e:
            logger.error("IMAP processing failed: %s", e)

    # Flush Kafka
    if producer:
        try:
            producer.flush()
            logger.info("Kafka flush complete")
        except Exception as e:
            logger.error("Kafka flush failed: %s", e)

    # Print summary
    logger.info("=" * 60)
    logger.info("Demo Complete - Summary")
    logger.info("=" * 60)
    logger.info(
        "Gmail: %d fetched, %d stored, %d published",
        stats["gmail_messages"],
        stats["gmail_stored"],
        stats["gmail_published"],
    )
    logger.info(
        "IMAP:  %d fetched, %d stored, %d published",
        stats["imap_messages"],
        stats["imap_stored"],
        stats["imap_published"],
    )
    logger.info("=" * 60)

    # Print watermarks
    logger.info("Current Watermarks:")
    if gmail_enabled:
        wm = watermark_store.get_watermark(tenant_id, gmail_account_id, "gmail", "INBOX")
        if wm:
            logger.info("  Gmail INBOX: %s", wm.watermark_json)
    if imap_enabled:
        folders_str = get_env("IMAP_FOLDERS", "INBOX")
        for folder in [f.strip() for f in folders_str.split(",")]:
            wm = watermark_store.get_watermark(tenant_id, imap_account_id, "imap", folder)
            if wm:
                logger.info("  IMAP %s: %s", folder, wm.watermark_json)

    return 0


if __name__ == "__main__":
    sys.exit(main())
