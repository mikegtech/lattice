"""Mail account registry for managing account configurations in Postgres."""

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

import psycopg
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class PostgresConfig(BaseModel):
    """Postgres connection configuration."""

    host: str = "localhost"
    port: int = 5432
    database: str = "lattice"
    user: str = "lattice"
    password: str = ""

    @classmethod
    def from_env(cls) -> "PostgresConfig":
        """Load from environment variables."""
        return cls(
            host=os.getenv("POSTGRES_HOST", "localhost"),
            port=int(os.getenv("POSTGRES_PORT", "5432")),
            database=os.getenv("POSTGRES_DB", "lattice"),
            user=os.getenv("POSTGRES_USER", "lattice"),
            password=os.getenv("POSTGRES_PASSWORD", ""),
        )

    @property
    def connection_string(self) -> str:
        """Build psycopg connection string."""
        return (
            f"host={self.host} port={self.port} dbname={self.database} "
            f"user={self.user} password={self.password}"
        )


@dataclass
class MailAccount:
    """Mail account configuration."""

    id: str
    tenant_id: str
    account_id: str
    alias: str
    provider: Literal["gmail", "imap"]
    enabled: bool
    config_json: dict[str, Any]
    source_folder: str
    data_classification: str
    created_at: datetime
    updated_at: datetime

    def get_gmail_label_name(self) -> str:
        """Get the Gmail label name for this account's alias."""
        return f"Lattice/{self.alias}"

    def get_imap_target_folder(self) -> str:
        """Get the IMAP target folder for processed messages."""
        return self.alias


class AccountRegistry:
    """Registry for mail account configurations."""

    def __init__(self, config: PostgresConfig | None = None) -> None:
        """Initialize account registry."""
        self.config = config or PostgresConfig.from_env()

    def _get_connection(self) -> psycopg.Connection[tuple[Any, ...]]:
        """Get database connection."""
        return psycopg.connect(self.config.connection_string)

    def _row_to_account(self, row: tuple[Any, ...]) -> MailAccount:
        """Convert a database row to MailAccount."""
        return MailAccount(
            id=str(row[0]),
            tenant_id=row[1],
            account_id=row[2],
            alias=row[3],
            provider=row[4],
            enabled=row[5],
            config_json=row[6],
            source_folder=row[7] or "INBOX",
            data_classification=row[8],
            created_at=row[9],
            updated_at=row[10],
        )

    def list_enabled_accounts(
        self,
        provider: Literal["gmail", "imap"] | None = None,
        tenant_id: str | None = None,
    ) -> list[MailAccount]:
        """
        List enabled mail accounts.

        Args:
            provider: Optional filter by provider
            tenant_id: Optional filter by tenant

        Returns:
            List of enabled mail accounts
        """
        query = """
            SELECT id, tenant_id, account_id, alias, provider, enabled,
                   config_json, source_folder, data_classification,
                   created_at, updated_at
            FROM mail_accounts
            WHERE enabled = true
        """
        params: list[Any] = []

        if provider:
            query += " AND provider = %s"
            params.append(provider)

        if tenant_id:
            query += " AND tenant_id = %s"
            params.append(tenant_id)

        query += " ORDER BY tenant_id, account_id"

        accounts: list[MailAccount] = []
        with self._get_connection() as conn, conn.cursor() as cur:
            cur.execute(query, params)
            for row in cur.fetchall():
                accounts.append(self._row_to_account(row))

        logger.debug("Listed %d enabled accounts", len(accounts))
        return accounts

    def get_account(
        self,
        tenant_id: str,
        account_id: str,
    ) -> MailAccount | None:
        """
        Get a specific account by tenant and account ID.

        Args:
            tenant_id: Tenant identifier
            account_id: Account identifier

        Returns:
            MailAccount if found, None otherwise
        """
        query = """
            SELECT id, tenant_id, account_id, alias, provider, enabled,
                   config_json, source_folder, data_classification,
                   created_at, updated_at
            FROM mail_accounts
            WHERE tenant_id = %s AND account_id = %s
        """

        with self._get_connection() as conn, conn.cursor() as cur:
            cur.execute(query, (tenant_id, account_id))
            row = cur.fetchone()
            if row:
                return self._row_to_account(row)

        return None

    def upsert_account(
        self,
        tenant_id: str,
        account_id: str,
        alias: str,
        provider: Literal["gmail", "imap"],
        config_json: dict[str, Any],
        source_folder: str = "INBOX",
        enabled: bool = True,
        data_classification: str = "confidential",
    ) -> MailAccount:
        """
        Insert or update a mail account.

        Args:
            tenant_id: Tenant identifier
            account_id: Account identifier
            alias: Stable logical label for post-processing routing
            provider: Mail provider
            config_json: Provider-specific configuration
            source_folder: IMAP source folder (default INBOX)
            enabled: Whether account is enabled
            data_classification: Data classification level

        Returns:
            The upserted MailAccount
        """
        query = """
            INSERT INTO mail_accounts (
                tenant_id, account_id, alias, provider, enabled,
                config_json, source_folder, data_classification
            ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s)
            ON CONFLICT (tenant_id, account_id)
            DO UPDATE SET
                alias = EXCLUDED.alias,
                provider = EXCLUDED.provider,
                enabled = EXCLUDED.enabled,
                config_json = EXCLUDED.config_json,
                source_folder = EXCLUDED.source_folder,
                data_classification = EXCLUDED.data_classification,
                updated_at = NOW()
            RETURNING id, tenant_id, account_id, alias, provider, enabled,
                      config_json, source_folder, data_classification,
                      created_at, updated_at
        """

        with self._get_connection() as conn, conn.cursor() as cur:
            cur.execute(
                query,
                (
                    tenant_id,
                    account_id,
                    alias,
                    provider,
                    enabled,
                    json.dumps(config_json),
                    source_folder,
                    data_classification,
                ),
            )
            row = cur.fetchone()
            conn.commit()

            if row is None:
                raise RuntimeError("Upsert did not return a row")

            logger.info(
                "Upserted account %s/%s (alias=%s, provider=%s)",
                tenant_id,
                account_id,
                alias,
                provider,
            )

            return self._row_to_account(row)

    def disable_account(self, tenant_id: str, account_id: str) -> bool:
        """
        Disable a mail account.

        Returns:
            True if account was disabled, False if not found
        """
        query = """
            UPDATE mail_accounts
            SET enabled = false, updated_at = NOW()
            WHERE tenant_id = %s AND account_id = %s
        """

        with self._get_connection() as conn, conn.cursor() as cur:
            cur.execute(query, (tenant_id, account_id))
            affected = cur.rowcount
            conn.commit()

        if affected > 0:
            logger.info("Disabled account %s/%s", tenant_id, account_id)
            return True
        return False
