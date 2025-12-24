"""Watermark storage for incremental mail sync."""

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
class GmailWatermark:
    """Gmail watermark state."""

    history_id: str

    def to_json(self) -> dict[str, Any]:
        """Convert to JSON-serializable dict."""
        return {"historyId": self.history_id}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "GmailWatermark":
        """Create from JSON dict."""
        return cls(history_id=data.get("historyId", ""))


@dataclass
class ImapWatermark:
    """IMAP watermark state."""

    uidvalidity: int
    last_uid: int

    def to_json(self) -> dict[str, Any]:
        """Convert to JSON-serializable dict."""
        return {"uidvalidity": self.uidvalidity, "last_uid": self.last_uid}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ImapWatermark":
        """Create from JSON dict."""
        return cls(
            uidvalidity=data.get("uidvalidity", 0),
            last_uid=data.get("last_uid", 0),
        )


@dataclass
class Watermark:
    """Generic watermark record."""

    id: str
    tenant_id: str
    account_id: str
    provider: Literal["gmail", "imap"]
    scope: str
    watermark_json: dict[str, Any]
    created_at: datetime
    updated_at: datetime

    def as_gmail(self) -> GmailWatermark:
        """Get as Gmail watermark."""
        return GmailWatermark.from_json(self.watermark_json)

    def as_imap(self) -> ImapWatermark:
        """Get as IMAP watermark."""
        return ImapWatermark.from_json(self.watermark_json)


class WatermarkStore:
    """Store for sync watermarks."""

    def __init__(self, config: PostgresConfig | None = None) -> None:
        """Initialize watermark store."""
        self.config = config or PostgresConfig.from_env()

    def _get_connection(self) -> psycopg.Connection[tuple[Any, ...]]:
        """Get database connection."""
        return psycopg.connect(self.config.connection_string)

    def get_watermark(
        self,
        tenant_id: str,
        account_id: str,
        provider: Literal["gmail", "imap"],
        scope: str,
    ) -> Watermark | None:
        """
        Get watermark for an account/scope.

        Args:
            tenant_id: Tenant identifier
            account_id: Account identifier
            provider: Mail provider
            scope: Scope (Gmail label/query, IMAP folder)

        Returns:
            Watermark if found, None otherwise
        """
        query = """
            SELECT id, tenant_id, account_id, provider, scope,
                   watermark_json, created_at, updated_at
            FROM mail_watermarks
            WHERE tenant_id = %s AND account_id = %s
              AND provider = %s AND scope = %s
        """

        with self._get_connection() as conn, conn.cursor() as cur:
            cur.execute(query, (tenant_id, account_id, provider, scope))
            row = cur.fetchone()
            if row:
                return Watermark(
                    id=str(row[0]),
                    tenant_id=row[1],
                    account_id=row[2],
                    provider=row[3],
                    scope=row[4],
                    watermark_json=row[5],
                    created_at=row[6],
                    updated_at=row[7],
                )

        return None

    def upsert_watermark(
        self,
        tenant_id: str,
        account_id: str,
        provider: Literal["gmail", "imap"],
        scope: str,
        watermark_json: dict[str, Any],
    ) -> Watermark:
        """
        Insert or update a watermark.

        Args:
            tenant_id: Tenant identifier
            account_id: Account identifier
            provider: Mail provider
            scope: Scope (Gmail label/query, IMAP folder)
            watermark_json: Watermark state

        Returns:
            The upserted Watermark
        """
        query = """
            INSERT INTO mail_watermarks (
                tenant_id, account_id, provider, scope, watermark_json
            ) VALUES (%s, %s, %s, %s, %s::jsonb)
            ON CONFLICT (tenant_id, account_id, provider, scope)
            DO UPDATE SET
                watermark_json = EXCLUDED.watermark_json,
                updated_at = NOW()
            RETURNING id, tenant_id, account_id, provider, scope,
                      watermark_json, created_at, updated_at
        """

        with self._get_connection() as conn, conn.cursor() as cur:
            cur.execute(
                query,
                (
                    tenant_id,
                    account_id,
                    provider,
                    scope,
                    json.dumps(watermark_json),
                ),
            )
            row = cur.fetchone()
            conn.commit()

            if row is None:
                raise RuntimeError("Upsert did not return a row")

            logger.debug(
                "Upserted watermark %s/%s/%s/%s",
                tenant_id,
                account_id,
                provider,
                scope,
            )

            return Watermark(
                id=str(row[0]),
                tenant_id=row[1],
                account_id=row[2],
                provider=row[3],
                scope=row[4],
                watermark_json=row[5],
                created_at=row[6],
                updated_at=row[7],
            )

    def upsert_gmail_watermark(
        self,
        tenant_id: str,
        account_id: str,
        scope: str,
        history_id: str,
    ) -> Watermark:
        """
        Upsert a Gmail watermark.

        Args:
            tenant_id: Tenant identifier
            account_id: Account identifier
            scope: Gmail scope (label/query)
            history_id: Gmail history ID

        Returns:
            The upserted Watermark
        """
        watermark = GmailWatermark(history_id=history_id)
        return self.upsert_watermark(
            tenant_id=tenant_id,
            account_id=account_id,
            provider="gmail",
            scope=scope,
            watermark_json=watermark.to_json(),
        )

    def upsert_imap_watermark(
        self,
        tenant_id: str,
        account_id: str,
        scope: str,
        uidvalidity: int,
        last_uid: int,
    ) -> Watermark:
        """
        Upsert an IMAP watermark.

        Args:
            tenant_id: Tenant identifier
            account_id: Account identifier
            scope: IMAP folder
            uidvalidity: UIDVALIDITY value
            last_uid: Last processed UID

        Returns:
            The upserted Watermark
        """
        watermark = ImapWatermark(uidvalidity=uidvalidity, last_uid=last_uid)
        return self.upsert_watermark(
            tenant_id=tenant_id,
            account_id=account_id,
            provider="imap",
            scope=scope,
            watermark_json=watermark.to_json(),
        )

    def list_watermarks(
        self,
        tenant_id: str,
        account_id: str,
        provider: Literal["gmail", "imap"] | None = None,
    ) -> list[Watermark]:
        """
        List all watermarks for an account.

        Args:
            tenant_id: Tenant identifier
            account_id: Account identifier
            provider: Optional filter by provider

        Returns:
            List of watermarks
        """
        query = """
            SELECT id, tenant_id, account_id, provider, scope,
                   watermark_json, created_at, updated_at
            FROM mail_watermarks
            WHERE tenant_id = %s AND account_id = %s
        """
        params: list[Any] = [tenant_id, account_id]

        if provider:
            query += " AND provider = %s"
            params.append(provider)

        query += " ORDER BY scope"

        watermarks: list[Watermark] = []
        with self._get_connection() as conn, conn.cursor() as cur:
            cur.execute(query, params)
            for row in cur.fetchall():
                watermarks.append(
                    Watermark(
                        id=str(row[0]),
                        tenant_id=row[1],
                        account_id=row[2],
                        provider=row[3],
                        scope=row[4],
                        watermark_json=row[5],
                        created_at=row[6],
                        updated_at=row[7],
                    )
                )

        return watermarks

    def delete_watermark(
        self,
        tenant_id: str,
        account_id: str,
        provider: Literal["gmail", "imap"],
        scope: str,
    ) -> bool:
        """
        Delete a watermark.

        Returns:
            True if deleted, False if not found
        """
        query = """
            DELETE FROM mail_watermarks
            WHERE tenant_id = %s AND account_id = %s
              AND provider = %s AND scope = %s
        """

        with self._get_connection() as conn, conn.cursor() as cur:
            cur.execute(query, (tenant_id, account_id, provider, scope))
            affected = cur.rowcount
            conn.commit()

        return affected > 0
