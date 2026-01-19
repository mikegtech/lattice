#!/usr/bin/env bash
# =============================================================================
# emit-deploy-marker.sh
# =============================================================================
# Sends a deployment marker to New Relic using the Events API.
#
# Required environment variables:
#   NEW_RELIC_API_KEY     - New Relic User API key (or Ingest License key)
#   NEW_RELIC_ACCOUNT_ID  - New Relic account ID
#
# Optional environment variables:
#   NEW_RELIC_REGION      - US (default) or EU
#
# Usage:
#   ./emit-deploy-marker.sh \
#     --service "my-service" \
#     --version "abc123" \
#     --status "success" \
#     --description "Deployed successfully"
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------
SERVICE=""
VERSION=""
STATUS="success"
DESCRIPTION=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --service)
      SERVICE="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --status)
      STATUS="$2"
      shift 2
      ;;
    --description)
      DESCRIPTION="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Validate required inputs
# -----------------------------------------------------------------------------
if [[ -z "${SERVICE}" ]]; then
  echo "Error: --service is required" >&2
  exit 1
fi

if [[ -z "${VERSION}" ]]; then
  echo "Error: --version is required" >&2
  exit 1
fi

if [[ -z "${NEW_RELIC_API_KEY:-}" ]]; then
  echo "Warning: NEW_RELIC_API_KEY not set, skipping deploy marker" >&2
  exit 0
fi

if [[ -z "${NEW_RELIC_ACCOUNT_ID:-}" ]]; then
  echo "Warning: NEW_RELIC_ACCOUNT_ID not set, skipping deploy marker" >&2
  exit 0
fi

# -----------------------------------------------------------------------------
# Determine API endpoint based on region
# -----------------------------------------------------------------------------
REGION="${NEW_RELIC_REGION:-US}"
if [[ "${REGION}" == "EU" ]]; then
  API_ENDPOINT="https://insights-collector.eu01.nr-data.net/v1/accounts/${NEW_RELIC_ACCOUNT_ID}/events"
else
  API_ENDPOINT="https://insights-collector.newrelic.com/v1/accounts/${NEW_RELIC_ACCOUNT_ID}/events"
fi

# -----------------------------------------------------------------------------
# Build event payload
# -----------------------------------------------------------------------------
TIMESTAMP=$(date +%s)

EVENT_PAYLOAD=$(cat <<EOF
[{
  "eventType": "Deployment",
  "service": "${SERVICE}",
  "version": "${VERSION}",
  "status": "${STATUS}",
  "description": "${DESCRIPTION}",
  "timestamp": ${TIMESTAMP},
  "environment": "production",
  "project": "lattice"
}]
EOF
)

# -----------------------------------------------------------------------------
# Send event to New Relic
# -----------------------------------------------------------------------------
echo "Sending deploy marker to New Relic..."
echo "  Service: ${SERVICE}"
echo "  Version: ${VERSION}"
echo "  Status: ${STATUS}"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${API_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -H "Api-Key: ${NEW_RELIC_API_KEY}" \
  -d "${EVENT_PAYLOAD}")

if [[ "${HTTP_STATUS}" -ge 200 && "${HTTP_STATUS}" -lt 300 ]]; then
  echo "Deploy marker sent successfully (HTTP ${HTTP_STATUS})"
else
  echo "Warning: Failed to send deploy marker (HTTP ${HTTP_STATUS})" >&2
  # Don't fail the workflow for marker failures
  exit 0
fi
