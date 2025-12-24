#!/usr/bin/env python3
"""
Seed mail accounts in Postgres for the two-inbox demo.

This script seeds two accounts:
1. personal-gmail - Gmail account with OAuth credentials from env
2. workmail-imap - WorkMail IMAP account with credentials from env

Usage:
    python -m scripts.seed_mail_accounts

Environment variables:
    POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
    TENANT_ID (default: personal)
    GMAIL_ACCOUNT_ID (default: personal-gmail)
    GMAIL_ALIAS (default: personal-gmail)
    GMAIL_USER_EMAIL (optional)
    IMAP_ACCOUNT_ID (default: workmail-imap)
    IMAP_ALIAS (default: workmail-processed)
    IMAP_HOST (optional, for config_json)
    IMAP_SOURCE_FOLDER (default: INBOX)

NOTE: Credentials (client_secret, refresh_token, passwords) are NOT stored in the DB.
      They must be provided via environment variables or Airflow connections.
"""

import logging
import os
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def get_env(name: str, default: str = "") -> str:
    """Get environment variable with optional default."""
    return os.getenv(name, default)


def main() -> int:
    """Seed mail accounts."""
    from lattice_mail.account_registry import AccountRegistry, PostgresConfig

    logger.info("=" * 60)
    logger.info("Lattice Mail Accounts Seeder")
    logger.info("=" * 60)

    # Configuration
    tenant_id = get_env("TENANT_ID", "personal")

    # Gmail account config
    gmail_account_id = get_env("GMAIL_ACCOUNT_ID", "personal-gmail")
    gmail_alias = get_env("GMAIL_ALIAS", "personal-gmail")
    gmail_user_email = get_env("GMAIL_USER_EMAIL", "")

    # IMAP account config
    imap_account_id = get_env("IMAP_ACCOUNT_ID", "workmail-imap")
    imap_alias = get_env("IMAP_ALIAS", "workmail-processed")
    imap_host = get_env("IMAP_HOST", "")
    imap_source_folder = get_env("IMAP_SOURCE_FOLDER", "INBOX")

    # Initialize registry
    pg_config = PostgresConfig.from_env()
    registry = AccountRegistry(pg_config)

    logger.info("Connected to Postgres: %s:%d", pg_config.host, pg_config.port)

    # Seed Gmail account
    logger.info("-" * 40)
    logger.info("Seeding Gmail account: %s", gmail_account_id)

    gmail_config = {
        "email": gmail_user_email or "configured-via-env",
        "scopes": ["INBOX"],
        "watch_labels": ["INBOX"],
    }

    gmail_account = registry.upsert_account(
        tenant_id=tenant_id,
        account_id=gmail_account_id,
        alias=gmail_alias,
        provider="gmail",
        config_json=gmail_config,
        source_folder="INBOX",  # Gmail ignores this, uses query
        enabled=True,
    )
    logger.info(
        "  Created/updated Gmail account: %s/%s (alias=%s)",
        gmail_account.tenant_id,
        gmail_account.account_id,
        gmail_account.alias,
    )

    # Seed IMAP account
    logger.info("-" * 40)
    logger.info("Seeding IMAP account: %s", imap_account_id)

    imap_config = {
        "host": imap_host or "configured-via-env",
        "port": 993,
        "folders": [imap_source_folder],
    }

    imap_account = registry.upsert_account(
        tenant_id=tenant_id,
        account_id=imap_account_id,
        alias=imap_alias,
        provider="imap",
        config_json=imap_config,
        source_folder=imap_source_folder,
        enabled=True,
    )
    logger.info(
        "  Created/updated IMAP account: %s/%s (alias=%s, source_folder=%s)",
        imap_account.tenant_id,
        imap_account.account_id,
        imap_account.alias,
        imap_account.source_folder,
    )

    # List all accounts
    logger.info("=" * 60)
    logger.info("All enabled accounts:")
    accounts = registry.list_enabled_accounts(tenant_id=tenant_id)
    for acc in accounts:
        logger.info(
            "  - %s/%s (provider=%s, alias=%s)",
            acc.tenant_id,
            acc.account_id,
            acc.provider,
            acc.alias,
        )

    logger.info("=" * 60)
    logger.info("Seeding complete!")
    logger.info("")
    logger.info("Next steps:")
    logger.info("  1. Set credential environment variables")
    logger.info("     (see docs/runbooks/demo-two-inboxes-airflow.md)")
    logger.info("  2. Trigger DAGs:")
    logger.info("     - lattice__gmail_sync_incremental")
    logger.info("     - lattice__imap_sync_incremental")
    logger.info("  Or trigger backfill DAGs with date parameters:")
    logger.info("     - lattice__gmail_backfill")
    logger.info("     - lattice__imap_backfill")

    return 0


if __name__ == "__main__":
    sys.exit(main())
