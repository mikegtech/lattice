"""Tests for alias routing logic in mail connectors."""

from datetime import datetime
from unittest.mock import MagicMock, patch


class TestMailAccountAliasRouting:
    """Tests for MailAccount alias routing methods."""

    def test_get_gmail_label_name(self) -> None:
        """Test Gmail label name generation from alias."""
        from lattice_mail.account_registry import MailAccount

        account = MailAccount(
            id="test-id",
            tenant_id="personal",
            account_id="my-gmail",
            alias="personal-inbox",
            provider="gmail",
            enabled=True,
            config_json={},
            source_folder="INBOX",
            data_classification="confidential",
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        label_name = account.get_gmail_label_name()
        assert label_name == "Lattice/personal-inbox"

    def test_get_gmail_label_name_with_special_chars(self) -> None:
        """Test Gmail label handles special characters in alias."""
        from lattice_mail.account_registry import MailAccount

        account = MailAccount(
            id="test-id",
            tenant_id="org",
            account_id="work-email",
            alias="work-2024",
            provider="gmail",
            enabled=True,
            config_json={},
            source_folder="INBOX",
            data_classification="confidential",
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        label_name = account.get_gmail_label_name()
        assert label_name == "Lattice/work-2024"

    def test_get_imap_target_folder(self) -> None:
        """Test IMAP target folder is the alias."""
        from lattice_mail.account_registry import MailAccount

        account = MailAccount(
            id="test-id",
            tenant_id="personal",
            account_id="workmail",
            alias="processed-mail",
            provider="imap",
            enabled=True,
            config_json={},
            source_folder="INBOX",
            data_classification="confidential",
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        folder = account.get_imap_target_folder()
        assert folder == "processed-mail"

    def test_imap_target_folder_matches_alias(self) -> None:
        """Verify IMAP target folder exactly matches alias."""
        from lattice_mail.account_registry import MailAccount

        alias = "my-custom-folder"
        account = MailAccount(
            id="test-id",
            tenant_id="tenant",
            account_id="account",
            alias=alias,
            provider="imap",
            enabled=True,
            config_json={},
            source_folder="INBOX",
            data_classification="confidential",
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        # Target folder should be exactly the alias (for moving messages)
        assert account.get_imap_target_folder() == alias


class TestImapCopyUid:
    """Tests for IMAP COPYUID parsing in connector."""

    def test_parse_copyuid_response_success(self) -> None:
        """Test parsing COPYUID response extracts destination UID."""
        from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector

        config = ImapConfig(
            host="test.example.com",
            username="test",
            password="test",  # pragma: allowlist secret
        )
        connector = ImapConnector(config)

        # Simulate COPYUID response: [COPYUID <uidvalidity> <src_uid> <dest_uid>]
        response_data = [b"[COPYUID 12345 100 200] OK"]

        dest_uid = connector._parse_copyuid_response(response_data)
        assert dest_uid == 200

    def test_parse_copyuid_response_no_copyuid(self) -> None:
        """Test parsing response without COPYUID returns None."""
        from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector

        config = ImapConfig(
            host="test.example.com",
            username="test",
            password="test",  # pragma: allowlist secret
        )
        connector = ImapConnector(config)

        # Response without COPYUID (server doesn't support UIDPLUS)
        response_data = [b"OK Copy completed"]

        dest_uid = connector._parse_copyuid_response(response_data)
        assert dest_uid is None

    def test_parse_copyuid_response_none_items(self) -> None:
        """Test parsing response with None items doesn't crash."""
        from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector

        config = ImapConfig(
            host="test.example.com",
            username="test",
            password="test",  # pragma: allowlist secret
        )
        connector = ImapConnector(config)

        response_data = [None, b"OK"]

        dest_uid = connector._parse_copyuid_response(response_data)
        assert dest_uid is None

    def test_parse_copyuid_response_mixed_content(self) -> None:
        """Test parsing response with mixed content finds COPYUID."""
        from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector

        config = ImapConfig(
            host="test.example.com",
            username="test",
            password="test",  # pragma: allowlist secret
        )
        connector = ImapConnector(config)

        # COPYUID might be in middle of response
        response_data = [
            b"* 1 EXPUNGE",
            b"[COPYUID 999 50 75] OK COPY completed",
        ]

        dest_uid = connector._parse_copyuid_response(response_data)
        assert dest_uid == 75

    @patch("imaplib.IMAP4_SSL")
    def test_copy_message_uses_copyuid(self, mock_imap_class: MagicMock) -> None:
        """Test copy_message extracts COPYUID from response."""
        from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector

        # Setup mock IMAP connection
        mock_conn = MagicMock()
        mock_imap_class.return_value = mock_conn
        mock_conn.login.return_value = ("OK", [])
        mock_conn.select.return_value = ("OK", [b"1"])
        mock_conn.status.return_value = ("OK", [b"INBOX (UIDVALIDITY 12345)"])
        mock_conn.list.return_value = ("OK", [b'(\\HasNoChildren) "/" "INBOX"'])

        # Mock copy command returning COPYUID
        mock_conn.uid.return_value = ("OK", [b"[COPYUID 12345 100 200] OK"])

        config = ImapConfig(
            host="test.example.com",
            username="test",
            password="test",  # pragma: allowlist secret
        )
        connector = ImapConnector(config)
        connector.connect()

        # Override folder exists check
        connector.folder_exists = MagicMock(return_value=True)

        dest_uid = connector.copy_message("INBOX", 100, "processed")

        assert dest_uid == 200
        mock_conn.uid.assert_called_with("copy", "100", "processed")

    @patch("imaplib.IMAP4_SSL")
    def test_copy_message_without_copyuid_logs_warning(self, mock_imap_class: MagicMock) -> None:
        """Test copy_message logs warning when COPYUID is not returned."""
        from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector

        # Setup mock IMAP connection
        mock_conn = MagicMock()
        mock_imap_class.return_value = mock_conn
        mock_conn.login.return_value = ("OK", [])
        mock_conn.select.return_value = ("OK", [b"1"])
        mock_conn.status.return_value = ("OK", [b"INBOX (UIDVALIDITY 12345)"])
        mock_conn.list.return_value = ("OK", [b'(\\HasNoChildren) "/" "INBOX"'])

        # Mock copy command WITHOUT COPYUID
        mock_conn.uid.return_value = ("OK", [b"OK Copy completed"])

        config = ImapConfig(
            host="test.example.com",
            username="test",
            password="test",  # pragma: allowlist secret
        )
        connector = ImapConnector(config)
        connector.connect()
        connector.folder_exists = MagicMock(return_value=True)

        with patch("lattice_mail.connectors.imap_connector.logger") as mock_logger:
            dest_uid = connector.copy_message("INBOX", 100, "processed")

            assert dest_uid is None
            # Should log a warning about missing COPYUID
            mock_logger.warning.assert_called()


class TestObjectStorageKeyWithAlias:
    """Tests for object storage key generation with alias."""

    def test_build_message_key_includes_alias(self) -> None:
        """Test message key includes alias in path."""
        from lattice_storage.object_store import build_message_key

        key = build_message_key(
            tenant_id="personal",
            account_id="my-account",
            alias="my-alias",
            provider="gmail",
            provider_message_id="msg123",
        )

        assert "alias/my-alias" in key
        assert key == (
            "tenant/personal/account/my-account/alias/my-alias"
            "/provider/gmail/message/msg123/message.eml"
        )

    def test_build_message_key_sanitizes_alias(self) -> None:
        """Test alias with special chars is sanitized."""
        from lattice_storage.object_store import build_message_key

        key = build_message_key(
            tenant_id="tenant",
            account_id="account",
            alias="my/alias:test",  # Contains / and :
            provider="imap",
            provider_message_id="uid123:456",
        )

        # / and : should be replaced with _
        assert "alias/my_alias_test" in key
        assert "message/uid123_456" in key

    def test_build_attachment_key_includes_alias(self) -> None:
        """Test attachment key includes alias in path."""
        from lattice_storage.object_store import build_attachment_key

        key = build_attachment_key(
            tenant_id="personal",
            account_id="account",
            alias="processed",
            provider="gmail",
            provider_message_id="msg123",
            attachment_id="att456",
            filename="document.pdf",
        )

        assert "alias/processed" in key
        assert "attachments/att456" in key
        assert key == (
            "tenant/personal/account/account/alias/processed"
            "/provider/gmail/message/msg123/attachments/att456/document.pdf"
        )


class TestRawEventWithAlias:
    """Tests for raw event builder with alias field."""

    def test_build_raw_event_includes_alias_in_envelope(self) -> None:
        """Test raw event envelope includes alias field."""
        from datetime import UTC

        from lattice_mail.raw_event import build_raw_event

        event = build_raw_event(
            tenant_id="personal",
            account_id="my-account",
            alias="my-alias",
            provider="gmail",
            provider_message_id="msg123",
            raw_bytes=b"test message content",
            raw_object_uri="s3://bucket/key",
            received_at=datetime.now(UTC),
        )

        # Alias should be in top-level envelope
        assert event["alias"] == "my-alias"

        # Alias should also be in provider_source
        assert event["provider_source"]["alias"] == "my-alias"

    def test_build_raw_event_includes_alias_for_imap(self) -> None:
        """Test raw event for IMAP includes alias."""
        from datetime import UTC

        from lattice_mail.raw_event import build_raw_event

        event = build_raw_event(
            tenant_id="org",
            account_id="workmail",
            alias="processed-folder",
            provider="imap",
            provider_message_id="12345:100",
            raw_bytes=b"imap message",
            raw_object_uri="s3://bucket/imap/key",
            received_at=datetime.now(UTC),
            scope="INBOX",
        )

        assert event["alias"] == "processed-folder"
        assert event["provider_source"]["alias"] == "processed-folder"
        assert event["provider_source"]["scope"] == "INBOX"
