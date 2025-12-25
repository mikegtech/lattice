#!/usr/bin/env python3
"""
Test Gmail connection and optionally get OAuth refresh token.

Usage:
    # Get refresh token (if not set):
    python -m scripts.test_gmail_connection --get-token

    # Test connection (if refresh token is set):
    python -m scripts.test_gmail_connection
"""

import os
import sys
import webbrowser
from pathlib import Path
from urllib.parse import urlencode

import requests

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


def get_oauth_url(client_id: str, redirect_uri: str = "http://localhost:8080") -> str:
    """Generate the OAuth authorization URL."""
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",
        "access_type": "offline",
        "prompt": "consent",
    }
    return f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"


def exchange_code_for_tokens(
    client_id: str, client_secret: str, auth_code: str, redirect_uri: str = "http://localhost:8080"
) -> dict:
    """Exchange authorization code for tokens."""
    response = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": auth_code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def test_gmail_connection(client_id: str, client_secret: str, refresh_token: str) -> None:
    """Test Gmail connection by fetching profile and recent messages."""
    from lattice_mail.connectors.gmail_connector import GmailConfig, GmailConnector

    print("\n" + "=" * 60)
    print("Testing Gmail Connection")
    print("=" * 60)

    config = GmailConfig(
        client_id=client_id,
        client_secret=client_secret,
        refresh_token=refresh_token,
        user_email="me",
    )

    gmail = GmailConnector(config)

    # Test 1: Get profile
    print("\n[1] Fetching Gmail profile...")
    try:
        profile = gmail.get_profile()
        print(f"    Email: {profile.get('emailAddress')}")
        print(f"    Total messages: {profile.get('messagesTotal')}")
        print(f"    History ID: {profile.get('historyId')}")
        print("    ✓ Profile fetch successful!")
    except Exception as e:
        print(f"    ✗ Failed: {e}")
        return

    # Test 2: List recent messages
    print("\n[2] Listing recent messages (last 7 days, max 5)...")
    try:
        message_ids, _ = gmail.list_message_ids_by_query("newer_than:7d", max_results=5)
        print(f"    Found {len(message_ids)} messages")
        if message_ids:
            print(f"    Message IDs: {message_ids}")
        print("    ✓ Message listing successful!")
    except Exception as e:
        print(f"    ✗ Failed: {e}")
        return

    # Test 3: Fetch a message (if any)
    if message_ids:
        print(f"\n[3] Fetching raw message ({message_ids[0][:12]}...)...")
        try:
            msg = gmail.get_message_raw(message_ids[0])
            print(f"    Thread ID: {msg.thread_id}")
            print(f"    Internal date: {msg.internal_date}")
            print(f"    Size: {msg.size_bytes} bytes")
            print(f"    Labels: {msg.label_ids}")
            print("    ✓ Message fetch successful!")
        except Exception as e:
            print(f"    ✗ Failed: {e}")
            return

    print("\n" + "=" * 60)
    print("All tests passed! Gmail connection is working.")
    print("=" * 60)


def get_refresh_token_flow() -> None:
    """Interactive flow to get a refresh token."""
    client_id = get_env("GMAIL_CLIENT_ID")
    client_secret = get_env("GMAIL_CLIENT_SECRET")

    if not client_id or not client_secret:
        print("ERROR: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("Gmail OAuth Refresh Token Setup")
    print("=" * 60)

    # Generate and display OAuth URL
    auth_url = get_oauth_url(client_id)
    print("\n[Step 1] Open this URL in your browser:\n")
    print(auth_url)

    # Ask if user wants to open browser automatically
    open_browser = input("\nOpen in browser automatically? [Y/n]: ").strip().lower()
    if open_browser != "n":
        webbrowser.open(auth_url)

    print("\n[Step 2] Sign in and authorize the app.")
    print("         You'll be redirected to http://localhost:8080?code=XXXXX")
    print("         Copy the 'code' parameter from the URL.")

    # Get the authorization code
    auth_code = input("\n[Step 3] Paste the authorization code here: ").strip()

    if not auth_code:
        print("ERROR: No authorization code provided.")
        sys.exit(1)

    # Exchange for tokens
    print("\n[Step 4] Exchanging code for tokens...")
    try:
        tokens = exchange_code_for_tokens(client_id, client_secret, auth_code)
        refresh_token = tokens.get("refresh_token")

        if refresh_token:
            print("\n" + "=" * 60)
            print("SUCCESS! Add this to your .env file:")
            print("=" * 60)
            print(f"\nGMAIL_REFRESH_TOKEN={refresh_token}\n")
            print("=" * 60)

            # Ask if user wants to test immediately
            test_now = input("\nTest the connection now? [Y/n]: ").strip().lower()
            if test_now != "n":
                test_gmail_connection(client_id, client_secret, refresh_token)
        else:
            print("ERROR: No refresh token in response.")
            print("Make sure 'access_type=offline' and 'prompt=consent'.")
            print(f"Response: {tokens}")
            sys.exit(1)

    except requests.HTTPError as e:
        print(f"ERROR: Token exchange failed: {e}")
        if e.response is not None:
            print(f"Response: {e.response.text}")
        sys.exit(1)


def main() -> int:
    """Main entry point."""
    if "--get-token" in sys.argv or "-g" in sys.argv:
        get_refresh_token_flow()
        return 0

    # Test connection
    client_id = get_env("GMAIL_CLIENT_ID")
    client_secret = get_env("GMAIL_CLIENT_SECRET")
    refresh_token = get_env("GMAIL_REFRESH_TOKEN")

    if not client_id or not client_secret:
        print("ERROR: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env")
        return 1

    if not refresh_token:
        print("ERROR: GMAIL_REFRESH_TOKEN is not set.")
        print("\nRun with --get-token to get a refresh token:")
        print("  python -m scripts.test_gmail_connection --get-token")
        return 1

    test_gmail_connection(client_id, client_secret, refresh_token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
