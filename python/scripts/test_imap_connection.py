#!/usr/bin/env python3
"""
Test IMAP connection (AWS WorkMail or other IMAP servers).

Usage:
    python -m scripts.test_imap_connection
"""

import os
import sys
from pathlib import Path

# Load .env manually
env_file = Path(__file__).parent.parent / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def get_env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def test_imap_connection() -> int:
    """Test IMAP connection by listing folders and fetching recent messages."""
    from lattice_mail.connectors.imap_connector import ImapConfig, ImapConnector

    host = get_env("IMAP_HOST")
    port = int(get_env("IMAP_PORT", "993"))
    username = get_env("IMAP_USERNAME")
    password = get_env("IMAP_PASSWORD")
    folders_str = get_env("IMAP_FOLDERS", "INBOX")

    if not host or not username or not password:
        print("ERROR: IMAP_HOST, IMAP_USERNAME, and IMAP_PASSWORD must be set in .env")
        print("\nCurrent values:")
        print(f"  IMAP_HOST={host or '(not set)'}")
        print(f"  IMAP_USERNAME={username or '(not set)'}")
        print(f"  IMAP_PASSWORD={'***' if password else '(not set)'}")
        return 1

    folders = [f.strip() for f in folders_str.split(",")]

    print("\n" + "=" * 60)
    print("Testing IMAP Connection")
    print("=" * 60)
    print(f"Host: {host}:{port}")
    print(f"User: {username}")
    print(f"Folders: {folders}")

    config = ImapConfig(
        host=host,
        port=port,
        username=username,
        password=password,
        folders=folders,
    )

    try:
        with ImapConnector(config) as imap:
            # Test 1: List folders
            print("\n[1] Listing all folders...")
            try:
                all_folders = imap.list_folders()
                print(f"    Found {len(all_folders)} folders:")
                for folder in all_folders[:10]:  # Show first 10
                    print(f"      - {folder}")
                if len(all_folders) > 10:
                    print(f"      ... and {len(all_folders) - 10} more")
                print("    ✓ Folder listing successful!")
            except Exception as e:
                print(f"    ✗ Failed: {e}")
                return 1

            # Test 2: Select INBOX and get stats
            print("\n[2] Selecting INBOX...")
            try:
                uidvalidity = imap.select_folder("INBOX")
                latest_uid = imap.get_latest_uid("INBOX")
                print(f"    UIDVALIDITY: {uidvalidity}")
                print(f"    Latest UID: {latest_uid}")
                print("    ✓ INBOX selected successfully!")
            except Exception as e:
                print(f"    ✗ Failed: {e}")
                return 1

            # Test 3: List recent messages
            print("\n[3] Listing recent messages (last 5)...")
            try:
                # Get last 5 UIDs
                start_uid = max(0, latest_uid - 5)
                uids, _ = imap.list_uids_since("INBOX", start_uid, limit=5)
                print(f"    Found {len(uids)} messages")
                if uids:
                    print(f"    UIDs: {uids}")
                print("    ✓ Message listing successful!")
            except Exception as e:
                print(f"    ✗ Failed: {e}")
                return 1

            # Test 4: Fetch a message (if any)
            if uids:
                print(f"\n[4] Fetching message (UID {uids[-1]})...")
                try:
                    msg = imap.fetch_message("INBOX", uids[-1])
                    print(f"    Provider ID: {msg.provider_message_id}")
                    print(f"    Folder: {msg.folder}")
                    print(f"    Internal date: {msg.internal_date}")
                    print(f"    Size: {msg.size_bytes} bytes")
                    print(f"    Flags: {msg.flags}")

                    # Extract subject from raw bytes
                    import email

                    parsed = email.message_from_bytes(msg.raw_bytes)
                    subject = parsed.get("Subject", "(no subject)")
                    print(f"    Subject: {subject[:60]}...")
                    print("    ✓ Message fetch successful!")
                except Exception as e:
                    print(f"    ✗ Failed: {e}")
                    return 1

            # Test 5: Check UIDPLUS capability
            print("\n[5] Checking server capabilities...")
            try:
                has_uidplus = imap._check_uidplus_capability()
                print(f"    UIDPLUS support: {'Yes' if has_uidplus else 'No'}")
                print("    ✓ Capability check successful!")
            except Exception as e:
                print(f"    ✗ Failed: {e}")

            print("\n" + "=" * 60)
            print("All tests passed! IMAP connection is working.")
            print("=" * 60)
            return 0

    except Exception as e:
        print(f"\n✗ Connection failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(test_imap_connection())
