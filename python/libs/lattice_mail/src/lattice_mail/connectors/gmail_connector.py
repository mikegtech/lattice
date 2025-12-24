"""Gmail API connector using OAuth2 refresh tokens."""

import base64
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import requests
from pydantic import BaseModel

logger = logging.getLogger(__name__)

GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1"
OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"


class GmailConfig(BaseModel):
    """Gmail connector configuration."""

    client_id: str
    client_secret: str
    refresh_token: str
    user_email: str = "me"  # 'me' refers to authenticated user


@dataclass
class GmailMessage:
    """Gmail message metadata and raw content."""

    message_id: str
    thread_id: str
    history_id: str
    internal_date: datetime
    label_ids: list[str]
    raw_bytes: bytes
    size_bytes: int


@dataclass
class GmailAttachment:
    """Gmail attachment metadata."""

    attachment_id: str
    filename: str
    mime_type: str
    size_bytes: int


class GmailConnector:
    """Connector for Gmail API with OAuth2 authentication."""

    def __init__(self, config: GmailConfig) -> None:
        """Initialize Gmail connector."""
        self.config = config
        self._access_token: str | None = None
        self._token_expiry: datetime | None = None

    def _get_access_token(self) -> str:
        """Get valid access token, refreshing if necessary."""
        now = datetime.now(UTC)

        # Return cached token if still valid (with 60s buffer)
        if self._access_token and self._token_expiry and now < self._token_expiry:
            return self._access_token

        # Refresh the token
        logger.debug("Refreshing Gmail access token")
        response = requests.post(
            OAUTH_TOKEN_URL,
            data={
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "refresh_token": self.config.refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()

        self._access_token = data["access_token"]
        expires_in = data.get("expires_in", 3600)
        # Set expiry with 60s buffer
        from datetime import timedelta

        self._token_expiry = now + timedelta(seconds=expires_in - 60)

        return self._access_token

    def _make_request(
        self,
        method: str,
        endpoint: str,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Make authenticated request to Gmail API."""
        token = self._get_access_token()
        url = f"{GMAIL_API_BASE}/users/{self.config.user_email}/{endpoint}"

        headers = {"Authorization": f"Bearer {token}"}
        if json_body:
            headers["Content-Type"] = "application/json"

        response = requests.request(
            method,
            url,
            headers=headers,
            params=params,
            json=json_body,
            timeout=60,
        )
        response.raise_for_status()
        return response.json()

    def list_message_ids_by_query(
        self,
        query: str,
        page_token: str | None = None,
        max_results: int = 100,
    ) -> tuple[list[str], str | None]:
        """
        List message IDs matching a query.

        Args:
            query: Gmail search query (e.g., 'newer_than:7d')
            page_token: Token for pagination
            max_results: Maximum messages per page

        Returns:
            Tuple of (message_ids, next_page_token)
        """
        params: dict[str, Any] = {
            "q": query,
            "maxResults": max_results,
        }
        if page_token:
            params["pageToken"] = page_token

        data = self._make_request("GET", "messages", params)

        messages = data.get("messages", [])
        message_ids = [m["id"] for m in messages]
        next_token = data.get("nextPageToken")

        logger.debug("Listed %d messages for query: %s", len(message_ids), query)
        return message_ids, next_token

    def list_history(
        self,
        start_history_id: str,
        label_id: str | None = None,
        max_results: int = 100,
    ) -> tuple[list[str], str | None]:
        """
        List message IDs changed since a history ID.

        Args:
            start_history_id: Starting history ID
            label_id: Optional label to filter by
            max_results: Maximum results per page

        Returns:
            Tuple of (message_ids, newest_history_id)

        Raises:
            requests.HTTPError: 404 if history is stale
        """
        params: dict[str, Any] = {
            "startHistoryId": start_history_id,
            "maxResults": max_results,
            "historyTypes": "messageAdded",
        }
        if label_id:
            params["labelIds"] = label_id

        try:
            data = self._make_request("GET", "history", params)
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                logger.warning("History ID %s is stale, needs full sync", start_history_id)
            raise

        # Extract message IDs from history records
        message_ids: list[str] = []
        for record in data.get("history", []):
            for added in record.get("messagesAdded", []):
                msg_id = added.get("message", {}).get("id")
                if msg_id:
                    message_ids.append(msg_id)

        newest_history_id = data.get("historyId")
        logger.debug(
            "History sync: %d new messages, newest historyId: %s",
            len(message_ids),
            newest_history_id,
        )
        return list(set(message_ids)), newest_history_id

    def get_message_raw(self, message_id: str) -> GmailMessage:
        """
        Fetch raw message content.

        Args:
            message_id: Gmail message ID

        Returns:
            GmailMessage with raw bytes and metadata
        """
        # Get message in RAW format
        params = {"format": "raw"}
        data = self._make_request("GET", f"messages/{message_id}", params)

        # Decode base64url raw content
        raw_b64 = data.get("raw", "")
        raw_bytes = base64.urlsafe_b64decode(raw_b64)

        # Parse internal date (milliseconds since epoch)
        internal_date_ms = int(data.get("internalDate", "0"))
        internal_date = datetime.fromtimestamp(internal_date_ms / 1000, tz=UTC)

        return GmailMessage(
            message_id=data["id"],
            thread_id=data.get("threadId", ""),
            history_id=data.get("historyId", ""),
            internal_date=internal_date,
            label_ids=data.get("labelIds", []),
            raw_bytes=raw_bytes,
            size_bytes=len(raw_bytes),
        )

    def get_message_metadata(self, message_id: str) -> dict[str, Any]:
        """
        Fetch message metadata only (faster than raw).

        Args:
            message_id: Gmail message ID

        Returns:
            Message metadata dict
        """
        params = {"format": "metadata", "metadataHeaders": ["Subject", "From", "To", "Date"]}
        return self._make_request("GET", f"messages/{message_id}", params)

    def list_attachments(self, message_id: str) -> list[GmailAttachment]:
        """
        List attachments for a message.

        Args:
            message_id: Gmail message ID

        Returns:
            List of attachment metadata
        """
        # Get message in FULL format to see parts
        params = {"format": "full"}
        data = self._make_request("GET", f"messages/{message_id}", params)

        attachments: list[GmailAttachment] = []

        def extract_attachments(parts: list[dict[str, Any]]) -> None:
            for part in parts:
                body = part.get("body", {})
                attachment_id = body.get("attachmentId")
                if attachment_id:
                    attachments.append(
                        GmailAttachment(
                            attachment_id=attachment_id,
                            filename=part.get("filename", "unknown"),
                            mime_type=part.get("mimeType", "application/octet-stream"),
                            size_bytes=body.get("size", 0),
                        )
                    )
                # Recurse into nested parts
                if "parts" in part:
                    extract_attachments(part["parts"])

        payload = data.get("payload", {})
        if "parts" in payload:
            extract_attachments(payload["parts"])

        return attachments

    def get_attachment(self, message_id: str, attachment_id: str) -> bytes:
        """
        Download attachment content.

        Args:
            message_id: Gmail message ID
            attachment_id: Attachment ID

        Returns:
            Attachment bytes
        """
        data = self._make_request(
            "GET",
            f"messages/{message_id}/attachments/{attachment_id}",
        )
        raw_b64 = data.get("data", "")
        return base64.urlsafe_b64decode(raw_b64)

    def get_profile(self) -> dict[str, Any]:
        """Get Gmail profile (email, history ID, etc.)."""
        return self._make_request("GET", "profile")

    # =========================================================================
    # Label Management
    # =========================================================================

    def list_labels(self) -> list[dict[str, Any]]:
        """
        List all labels in the mailbox.

        Returns:
            List of label objects with id, name, type, etc.
        """
        data = self._make_request("GET", "labels")
        return data.get("labels", [])

    def get_label_by_name(self, name: str) -> dict[str, Any] | None:
        """
        Find a label by its name.

        Args:
            name: Label name (e.g., 'Lattice/personal')

        Returns:
            Label object if found, None otherwise
        """
        labels = self.list_labels()
        for label in labels:
            if label.get("name") == name:
                return label
        return None

    def create_label(self, name: str) -> dict[str, Any]:
        """
        Create a new label.

        Args:
            name: Label name (e.g., 'Lattice/personal')

        Returns:
            Created label object with id, name, etc.
        """
        body = {
            "name": name,
            "labelListVisibility": "labelShow",
            "messageListVisibility": "show",
        }
        label = self._make_request("POST", "labels", json_body=body)
        logger.info("Created Gmail label: %s (id=%s)", name, label.get("id"))
        return label

    def ensure_label_exists(self, name: str) -> str:
        """
        Ensure a label exists, creating it if necessary.

        Args:
            name: Label name (e.g., 'Lattice/personal')

        Returns:
            Label ID
        """
        existing = self.get_label_by_name(name)
        if existing:
            return existing["id"]
        new_label = self.create_label(name)
        return new_label["id"]

    def apply_label(self, message_id: str, label_id: str) -> None:
        """
        Apply a label to a message.

        Args:
            message_id: Gmail message ID
            label_id: Label ID to apply
        """
        body = {"addLabelIds": [label_id]}
        self._make_request("POST", f"messages/{message_id}/modify", json_body=body)
        logger.debug("Applied label %s to message %s", label_id, message_id)

    def apply_alias_label(self, message_id: str, alias: str) -> None:
        """
        Apply the Lattice/<alias> label to a message.

        This is the post-processing step after successful store+publish.
        Creates the label if it doesn't exist.

        Args:
            message_id: Gmail message ID
            alias: Account alias (label will be 'Lattice/<alias>')
        """
        label_name = f"Lattice/{alias}"
        label_id = self.ensure_label_exists(label_name)
        self.apply_label(message_id, label_id)
        logger.info("Applied alias label '%s' to message", label_name)

    def remove_label(self, message_id: str, label_id: str) -> None:
        """
        Remove a label from a message.

        Args:
            message_id: Gmail message ID
            label_id: Label ID to remove
        """
        body = {"removeLabelIds": [label_id]}
        self._make_request("POST", f"messages/{message_id}/modify", json_body=body)
        logger.debug("Removed label %s from message %s", label_id, message_id)

    def has_label(self, message_id: str, label_name: str) -> bool:
        """
        Check if a message has a specific label.

        Args:
            message_id: Gmail message ID
            label_name: Label name to check

        Returns:
            True if message has the label
        """
        label = self.get_label_by_name(label_name)
        if not label:
            return False

        msg_data = self.get_message_metadata(message_id)
        return label["id"] in msg_data.get("labelIds", [])
