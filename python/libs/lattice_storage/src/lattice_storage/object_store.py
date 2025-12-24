"""S3-compatible object storage abstraction for MinIO/S3."""

import logging
import os
from io import BytesIO
from typing import BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class ObjectStoreConfig(BaseModel):
    """Configuration for S3-compatible object storage."""

    endpoint_url: str | None = None  # None for AWS S3, set for MinIO
    access_key: str
    secret_key: str
    region: str = "us-east-1"
    default_bucket: str = "lattice-raw"

    @classmethod
    def from_env(cls) -> "ObjectStoreConfig":
        """Load configuration from environment variables."""
        return cls(
            endpoint_url=os.getenv("MINIO_ENDPOINT") or os.getenv("S3_ENDPOINT"),
            access_key=os.getenv("MINIO_ACCESS_KEY") or os.getenv("AWS_ACCESS_KEY_ID", ""),
            secret_key=os.getenv("MINIO_SECRET_KEY") or os.getenv("AWS_SECRET_ACCESS_KEY", ""),
            region=os.getenv("AWS_REGION", "us-east-1"),
            default_bucket=os.getenv("STORAGE_BUCKET", "lattice-raw"),
        )


class ObjectStore:
    """S3-compatible object storage client for MinIO/S3."""

    def __init__(self, config: ObjectStoreConfig | None = None) -> None:
        """Initialize object store with config."""
        self.config = config or ObjectStoreConfig.from_env()
        self._client = boto3.client(
            "s3",
            endpoint_url=self.config.endpoint_url,
            aws_access_key_id=self.config.access_key,
            aws_secret_access_key=self.config.secret_key,
            region_name=self.config.region,
            config=Config(signature_version="s3v4"),
        )

    def ensure_bucket(self, bucket: str | None = None) -> None:
        """Ensure bucket exists, create if not."""
        bucket = bucket or self.config.default_bucket
        try:
            self._client.head_bucket(Bucket=bucket)
            logger.debug("Bucket %s exists", bucket)
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "")
            if error_code in ("404", "NoSuchBucket"):
                logger.info("Creating bucket %s", bucket)
                self._client.create_bucket(Bucket=bucket)
            else:
                raise

    def put_bytes(
        self,
        key: str,
        data: bytes,
        content_type: str = "application/octet-stream",
        bucket: str | None = None,
    ) -> str:
        """
        Upload bytes to object storage.

        Args:
            key: Object key (path)
            data: Raw bytes to upload
            content_type: MIME content type
            bucket: Target bucket (uses default if not specified)

        Returns:
            URI in format s3://{bucket}/{key}
        """
        bucket = bucket or self.config.default_bucket
        self._client.put_object(
            Bucket=bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )
        uri = f"s3://{bucket}/{key}"
        logger.debug("Uploaded %d bytes to %s", len(data), uri)
        return uri

    def put_stream(
        self,
        key: str,
        stream: BinaryIO,
        content_type: str = "application/octet-stream",
        bucket: str | None = None,
    ) -> str:
        """
        Upload stream to object storage.

        Args:
            key: Object key (path)
            stream: File-like object to upload
            content_type: MIME content type
            bucket: Target bucket (uses default if not specified)

        Returns:
            URI in format s3://{bucket}/{key}
        """
        bucket = bucket or self.config.default_bucket
        self._client.upload_fileobj(
            stream,
            bucket,
            key,
            ExtraArgs={"ContentType": content_type},
        )
        uri = f"s3://{bucket}/{key}"
        logger.debug("Uploaded stream to %s", uri)
        return uri

    def get_bytes(self, key: str, bucket: str | None = None) -> bytes:
        """
        Download object as bytes.

        Args:
            key: Object key
            bucket: Source bucket (uses default if not specified)

        Returns:
            Object contents as bytes
        """
        bucket = bucket or self.config.default_bucket
        response = self._client.get_object(Bucket=bucket, Key=key)
        return response["Body"].read()

    def get_stream(self, key: str, bucket: str | None = None) -> BinaryIO:
        """
        Download object as stream.

        Args:
            key: Object key
            bucket: Source bucket (uses default if not specified)

        Returns:
            File-like object with contents
        """
        data = self.get_bytes(key, bucket)
        return BytesIO(data)

    def exists(self, key: str, bucket: str | None = None) -> bool:
        """Check if object exists."""
        bucket = bucket or self.config.default_bucket
        try:
            self._client.head_object(Bucket=bucket, Key=key)
            return True
        except ClientError:
            return False


def build_message_key(
    tenant_id: str,
    account_id: str,
    alias: str,
    provider: str,
    provider_message_id: str,
    filename: str = "message.eml",
) -> str:
    """
    Build object key for a message.

    Args:
        tenant_id: Tenant identifier
        account_id: Account identifier
        alias: Stable logical label for routing
        provider: Mail provider (gmail, imap)
        provider_message_id: Provider-specific message ID
        filename: Output filename (default: message.eml)

    Returns:
        Object key path

    Format: tenant/{tenant_id}/account/{account_id}/alias/{alias}/
            provider/{provider}/message/{msg_id}/{filename}
    """
    # Sanitize IDs for use in paths
    safe_msg_id = provider_message_id.replace("/", "_").replace(":", "_")
    safe_alias = alias.replace("/", "_").replace(":", "_")
    return (
        f"tenant/{tenant_id}/account/{account_id}/alias/{safe_alias}"
        f"/provider/{provider}/message/{safe_msg_id}/{filename}"
    )


def build_attachment_key(
    tenant_id: str,
    account_id: str,
    alias: str,
    provider: str,
    provider_message_id: str,
    attachment_id: str,
    filename: str,
) -> str:
    """
    Build object key for an attachment.

    Args:
        tenant_id: Tenant identifier
        account_id: Account identifier
        alias: Stable logical label for routing
        provider: Mail provider
        provider_message_id: Provider-specific message ID
        attachment_id: Attachment ID
        filename: Attachment filename

    Returns:
        Object key path

    Format: tenant/{tenant_id}/account/{account_id}/alias/{alias}/
            provider/{provider}/message/{msg_id}/attachments/{att_id}/{filename}
    """
    safe_msg_id = provider_message_id.replace("/", "_").replace(":", "_")
    safe_alias = alias.replace("/", "_").replace(":", "_")
    safe_att_id = attachment_id.replace("/", "_").replace(":", "_")
    safe_filename = filename.replace("/", "_")
    return (
        f"tenant/{tenant_id}/account/{account_id}/alias/{safe_alias}"
        f"/provider/{provider}/message/{safe_msg_id}/attachments/{safe_att_id}/{safe_filename}"
    )
