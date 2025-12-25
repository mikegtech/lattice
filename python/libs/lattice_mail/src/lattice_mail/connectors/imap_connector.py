"""IMAP connector for Amazon WorkMail and other IMAP servers."""

import contextlib
import email
import imaplib
import logging
import re
import ssl
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

from pydantic import BaseModel

logger = logging.getLogger(__name__)


class ImapConfig(BaseModel):
    """IMAP connector configuration."""

    host: str
    port: int = 993
    username: str
    password: str
    use_ssl: bool = True
    folders: list[str] = ["INBOX"]


@dataclass
class ImapMessage:
    """IMAP message metadata and raw content."""

    uid: int
    uidvalidity: int
    folder: str
    flags: list[str]
    internal_date: datetime
    raw_bytes: bytes
    size_bytes: int

    @property
    def provider_message_id(self) -> str:
        """Generate provider message ID from UID/UIDVALIDITY."""
        return f"{self.uidvalidity}:{self.uid}"


@dataclass
class ImapAttachment:
    """IMAP attachment metadata (extracted from MIME)."""

    attachment_id: str  # Generated: {message_uid}_{part_index}
    filename: str
    content_type: str
    size_bytes: int
    part_index: int


class ImapConnector:
    """Connector for IMAP servers (Amazon WorkMail, etc.)."""

    def __init__(self, config: ImapConfig) -> None:
        """Initialize IMAP connector."""
        self.config = config
        self._connection: imaplib.IMAP4_SSL | imaplib.IMAP4 | None = None
        self._current_folder: str | None = None
        self._current_uidvalidity: int | None = None

    def connect(self) -> None:
        """Establish connection to IMAP server."""
        if self._connection:
            return

        logger.debug("Connecting to IMAP server %s:%d", self.config.host, self.config.port)

        if self.config.use_ssl:
            context = ssl.create_default_context()
            self._connection = imaplib.IMAP4_SSL(
                self.config.host,
                self.config.port,
                ssl_context=context,
            )
        else:
            self._connection = imaplib.IMAP4(self.config.host, self.config.port)

        # Login
        self._connection.login(self.config.username, self.config.password)
        logger.info("Connected to IMAP server %s", self.config.host)

    def disconnect(self) -> None:
        """Close IMAP connection."""
        if self._connection:
            with contextlib.suppress(Exception):
                self._connection.logout()
            self._connection = None
            self._current_folder = None
            self._current_uidvalidity = None

    def __enter__(self) -> "ImapConnector":
        """Context manager entry."""
        self.connect()
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.disconnect()

    def _ensure_connected(self) -> imaplib.IMAP4_SSL | imaplib.IMAP4:
        """Ensure we have an active connection."""
        if not self._connection:
            self.connect()
        assert self._connection is not None
        return self._connection

    def select_folder(self, folder: str) -> int:
        """
        Select an IMAP folder.

        Args:
            folder: Folder name (e.g., 'INBOX')

        Returns:
            UIDVALIDITY value for the folder
        """
        conn = self._ensure_connected()

        if self._current_folder == folder and self._current_uidvalidity:
            return self._current_uidvalidity

        status, data = conn.select(folder)
        if status != "OK":
            raise RuntimeError(f"Failed to select folder {folder}: {data}")

        # Get UIDVALIDITY
        status, response = conn.status(folder, "(UIDVALIDITY)")
        if status != "OK":
            raise RuntimeError(f"Failed to get UIDVALIDITY for {folder}")

        # Parse UIDVALIDITY from response like: b'INBOX (UIDVALIDITY 12345)'
        match = re.search(rb"UIDVALIDITY\s+(\d+)", response[0])
        if not match:
            raise RuntimeError(f"Could not parse UIDVALIDITY from {response}")

        uidvalidity = int(match.group(1))
        self._current_folder = folder
        self._current_uidvalidity = uidvalidity

        logger.debug("Selected folder %s with UIDVALIDITY %d", folder, uidvalidity)
        return uidvalidity

    def get_latest_uid(self, folder: str) -> int:
        """
        Get the latest UID in a folder.

        Args:
            folder: Folder name

        Returns:
            Latest UID (0 if folder is empty)
        """
        conn = self._ensure_connected()
        self.select_folder(folder)

        # Search for all messages and get the last one
        status, data = conn.uid("search", None, "ALL")
        if status != "OK":
            return 0

        uids = data[0].split()
        if not uids:
            return 0

        return int(uids[-1])

    def list_uids_since(
        self,
        folder: str,
        since_uid: int,
        limit: int = 100,
    ) -> tuple[list[int], int]:
        """
        List UIDs greater than a given UID.

        Args:
            folder: Folder name
            since_uid: Starting UID (exclusive)
            limit: Maximum number of UIDs to return

        Returns:
            Tuple of (list of UIDs, UIDVALIDITY)
        """
        conn = self._ensure_connected()
        uidvalidity = self.select_folder(folder)

        # Search for UIDs greater than since_uid
        # UID range: from since_uid+1 to * if we have a starting point
        search_criteria = f"UID {since_uid + 1}:*" if since_uid > 0 else "ALL"

        status, data = conn.uid("search", None, search_criteria)
        if status != "OK":
            logger.warning("UID search failed in folder %s", folder)
            return [], uidvalidity

        uids_bytes = data[0].split()
        uids = [int(u) for u in uids_bytes if int(u) > since_uid]

        # Apply limit, taking the oldest first (for incremental processing)
        uids = sorted(uids)[:limit]

        logger.debug("Found %d new UIDs in %s since UID %d", len(uids), folder, since_uid)
        return uids, uidvalidity

    def fetch_message(self, folder: str, uid: int) -> ImapMessage:
        """
        Fetch a single message by UID.

        Args:
            folder: Folder name
            uid: Message UID

        Returns:
            ImapMessage with raw bytes and metadata
        """
        conn = self._ensure_connected()
        uidvalidity = self.select_folder(folder)

        # Fetch RFC822 content and FLAGS
        status, data = conn.uid("fetch", str(uid), "(RFC822 FLAGS INTERNALDATE)")
        if status != "OK" or not data or data[0] is None:
            raise RuntimeError(f"Failed to fetch message UID {uid} from {folder}")

        # Parse response
        # data[0] is a tuple: (header_info, message_bytes)
        msg_data = data[0]
        if isinstance(msg_data, tuple):
            header_info = msg_data[0].decode("utf-8", errors="replace")
            raw_bytes = msg_data[1]
        else:
            raise RuntimeError(f"Unexpected fetch response format: {type(msg_data)}")

        # Extract FLAGS from header
        flags_match = re.search(r"FLAGS \(([^)]*)\)", header_info)
        flags = flags_match.group(1).split() if flags_match else []

        # Extract INTERNALDATE
        date_match = re.search(r'INTERNALDATE "([^"]+)"', header_info)
        if date_match:
            try:
                internal_date = parsedate_to_datetime(date_match.group(1))
                if internal_date.tzinfo is None:
                    internal_date = internal_date.replace(tzinfo=UTC)
            except Exception:
                internal_date = datetime.now(UTC)
        else:
            internal_date = datetime.now(UTC)

        return ImapMessage(
            uid=uid,
            uidvalidity=uidvalidity,
            folder=folder,
            flags=flags,
            internal_date=internal_date,
            raw_bytes=raw_bytes,
            size_bytes=len(raw_bytes),
        )

    def extract_attachments_metadata(
        self,
        raw_bytes: bytes,
        uid: int,
    ) -> list[ImapAttachment]:
        """
        Extract attachment metadata from raw MIME message.

        Args:
            raw_bytes: Raw RFC822 message bytes
            uid: Message UID (for generating attachment IDs)

        Returns:
            List of attachment metadata
        """
        attachments: list[ImapAttachment] = []

        try:
            msg = email.message_from_bytes(raw_bytes)

            for idx, part in enumerate(msg.walk()):
                content_disposition = part.get("Content-Disposition", "")
                if "attachment" in content_disposition.lower():
                    filename = part.get_filename() or f"attachment_{idx}"
                    content_type = part.get_content_type()
                    payload = part.get_payload(decode=True)
                    size = len(payload) if payload else 0

                    attachments.append(
                        ImapAttachment(
                            attachment_id=f"{uid}_{idx}",
                            filename=filename,
                            content_type=content_type,
                            size_bytes=size,
                            part_index=idx,
                        )
                    )
        except Exception as e:
            logger.warning("Failed to parse MIME for attachment extraction: %s", e)

        return attachments

    def list_folders(self) -> list[str]:
        """List all available folders."""
        conn = self._ensure_connected()
        status, data = conn.list()
        if status != "OK":
            return []

        folders: list[str] = []
        for item in data:
            if isinstance(item, bytes):
                # Parse folder name from response like: b'(\\HasNoChildren) "/" "INBOX"'
                match = re.search(rb'"([^"]+)"$', item)
                if match:
                    folders.append(match.group(1).decode("utf-8"))

        return folders

    # =========================================================================
    # Folder Management
    # =========================================================================

    def folder_exists(self, folder: str) -> bool:
        """
        Check if a folder exists.

        Args:
            folder: Folder name

        Returns:
            True if folder exists
        """
        return folder in self.list_folders()

    def create_folder(self, folder: str) -> None:
        """
        Create a folder if it doesn't exist.

        Args:
            folder: Folder name to create
        """
        conn = self._ensure_connected()

        if self.folder_exists(folder):
            logger.debug("Folder '%s' already exists", folder)
            return

        status, data = conn.create(folder)
        if status != "OK":
            raise RuntimeError(f"Failed to create folder '{folder}': {data}")

        # Subscribe to the folder so it appears in clients
        conn.subscribe(folder)
        logger.info("Created and subscribed to folder: %s", folder)

    def ensure_folder_exists(self, folder: str) -> None:
        """
        Ensure a folder exists, creating it if necessary.

        Args:
            folder: Folder name
        """
        if not self.folder_exists(folder):
            self.create_folder(folder)

    # =========================================================================
    # Message Move with COPYUID Support
    # =========================================================================

    def _check_uidplus_capability(self) -> bool:
        """Check if server supports UIDPLUS extension."""
        conn = self._ensure_connected()
        status, data = conn.capability()
        if status != "OK":
            return False

        capabilities = data[0].decode("utf-8").upper() if data[0] else ""
        return "UIDPLUS" in capabilities

    def _parse_copyuid_response(self, response_data: list[Any]) -> int | None:
        """
        Parse COPYUID response to extract destination UID.

        UIDPLUS COPYUID response format:
        [COPYUID <uidvalidity> <source_uid_set> <dest_uid_set>]

        Args:
            response_data: Raw response from COPY command

        Returns:
            Destination UID if COPYUID present, None otherwise
        """
        for item in response_data:
            if item is None:
                continue

            text = item.decode("utf-8") if isinstance(item, bytes) else str(item)

            # Look for COPYUID response: [COPYUID 12345 100 200]
            match = re.search(r"\[COPYUID\s+(\d+)\s+(\d+)\s+(\d+)\]", text, re.IGNORECASE)
            if match:
                dest_uid = int(match.group(3))
                logger.debug("COPYUID: destination UID = %d", dest_uid)
                return dest_uid

        return None

    def copy_message(
        self,
        source_folder: str,
        uid: int,
        dest_folder: str,
    ) -> int | None:
        """
        Copy a message to another folder.

        Uses COPYUID (UIDPLUS extension) if available to identify the
        destination UID. Falls back to None if COPYUID is not supported.

        Args:
            source_folder: Source folder name
            uid: Message UID in source folder
            dest_folder: Destination folder name

        Returns:
            Destination UID if COPYUID is available, None otherwise
        """
        conn = self._ensure_connected()
        self.select_folder(source_folder)

        # Ensure destination folder exists
        self.ensure_folder_exists(dest_folder)

        # Perform UID COPY
        status, data = conn.uid("copy", str(uid), dest_folder)
        if status != "OK":
            raise RuntimeError(f"Failed to copy message UID {uid} to {dest_folder}: {data}")

        # Try to parse COPYUID response
        dest_uid = self._parse_copyuid_response(data)

        if dest_uid is None:
            # COPYUID not in response, log warning (but don't log PII like message content)
            logger.warning(
                "COPYUID not returned by server for copy to folder. "
                "Message moved but destination UID unknown."
            )

        return dest_uid

    def delete_message(self, folder: str, uid: int) -> None:
        """
        Mark a message as deleted (but don't expunge yet).

        Uses +FLAGS.SILENT to suppress untagged FETCH response.

        Args:
            folder: Folder name
            uid: Message UID
        """
        conn = self._ensure_connected()
        self.select_folder(folder)

        # Use .SILENT to suppress the untagged FETCH response
        status, data = conn.uid("store", str(uid), "+FLAGS.SILENT", "(\\Deleted)")
        if status != "OK":
            raise RuntimeError(f"Failed to mark message UID {uid} as deleted: {data}")

        logger.debug("Marked message UID %d as deleted in %s", uid, folder)

    def expunge(self) -> None:
        """Expunge deleted messages from current folder."""
        conn = self._ensure_connected()
        status, data = conn.expunge()
        if status != "OK":
            logger.warning("Expunge returned non-OK status: %s", data)

    def move_message(
        self,
        source_folder: str,
        uid: int,
        dest_folder: str,
    ) -> int | None:
        """
        Move a message from source to destination folder.

        This performs COPY + DELETE + EXPUNGE. Uses COPYUID if available
        to return the destination UID.

        Args:
            source_folder: Source folder name
            uid: Message UID in source folder
            dest_folder: Destination folder name

        Returns:
            Destination UID if COPYUID is available, None otherwise
        """
        # Copy to destination
        dest_uid = self.copy_message(source_folder, uid, dest_folder)

        # Delete from source
        self.delete_message(source_folder, uid)

        # Expunge to actually remove deleted messages
        self.expunge()

        logger.debug("Moved message UID %d from %s to %s", uid, source_folder, dest_folder)
        return dest_uid

    def move_to_alias_folder(
        self,
        source_folder: str,
        uid: int,
        alias: str,
    ) -> int | None:
        """
        Move a message to the alias folder after successful processing.

        This is the IMAP post-processing step after successful store+publish.
        Creates the alias folder if it doesn't exist.

        Args:
            source_folder: Source folder (e.g., 'INBOX')
            uid: Message UID
            alias: Account alias (destination folder name)

        Returns:
            Destination UID if available, None otherwise
        """
        dest_uid = self.move_message(source_folder, uid, alias)
        logger.info("Moved message to alias folder '%s'", alias)
        return dest_uid

    # =========================================================================
    # Message Flags (for keyword-based processing markers)
    # =========================================================================

    def add_flag(self, folder: str, uid: int, flag: str) -> None:
        """
        Add a flag to a message.

        Args:
            folder: Folder name
            uid: Message UID
            flag: Flag to add (e.g., '$LatticeProcessed')
        """
        conn = self._ensure_connected()
        self.select_folder(folder)

        status, data = conn.uid("store", str(uid), "+FLAGS", flag)
        if status != "OK":
            logger.warning("Failed to add flag %s to message UID %d: %s", flag, uid, data)

    def has_flag(self, folder: str, uid: int, flag: str) -> bool:
        """
        Check if a message has a specific flag.

        Args:
            folder: Folder name
            uid: Message UID
            flag: Flag to check

        Returns:
            True if message has the flag
        """
        conn = self._ensure_connected()
        self.select_folder(folder)

        status, data = conn.uid("fetch", str(uid), "(FLAGS)")
        if status != "OK" or not data or data[0] is None:
            return False

        flags_str = data[0].decode("utf-8") if isinstance(data[0], bytes) else str(data[0])
        return flag in flags_str

    def list_uids_without_flag(
        self,
        folder: str,
        flag: str,
        limit: int = 100,
    ) -> tuple[list[int], int]:
        """
        List UIDs of messages that don't have a specific flag.

        Useful for finding unprocessed messages if using flag-based markers.

        Args:
            folder: Folder name
            flag: Flag to check for absence
            limit: Maximum UIDs to return

        Returns:
            Tuple of (list of UIDs, UIDVALIDITY)
        """
        conn = self._ensure_connected()
        uidvalidity = self.select_folder(folder)

        # Search for messages NOT having the flag
        status, data = conn.uid("search", None, f"UNKEYWORD {flag}")
        if status != "OK":
            logger.warning("Flag search failed in folder %s", folder)
            return [], uidvalidity

        uids_bytes = data[0].split()
        uids = [int(u) for u in uids_bytes][:limit]

        logger.debug("Found %d messages without flag %s in %s", len(uids), flag, folder)
        return uids, uidvalidity
