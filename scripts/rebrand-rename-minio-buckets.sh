#!/usr/bin/env bash
# ============================================================================
# Rebrand: Rename all kb-* MinIO buckets to basefyio-*
# ============================================================================
#
# Prerequisites: mc (MinIO Client) must be installed and configured.
#
# Usage:
#   MC_ALIAS=myminio bash scripts/rebrand-rename-minio-buckets.sh
#
# MinIO doesn't support bucket rename, so we mirror + remove.
# ============================================================================

set -euo pipefail

ALIAS="${MC_ALIAS:?Set MC_ALIAS to your mc alias (e.g. myminio)}"

echo "Listing kb-* buckets on ${ALIAS}..."

BUCKETS=$(mc ls "${ALIAS}/" --json 2>/dev/null | jq -r '.key' | sed 's:/$::' | grep '^kb-' || true)

if [ -z "$BUCKETS" ]; then
  echo "No kb-* buckets found. Nothing to do."
  exit 0
fi

echo "Found buckets to rename:"
echo "$BUCKETS"
echo ""

for OLD_BUCKET in $BUCKETS; do
  NEW_BUCKET="basefyio-${OLD_BUCKET#kb-}"
  echo "--- ${OLD_BUCKET} → ${NEW_BUCKET} ---"

  # Create new bucket
  mc mb "${ALIAS}/${NEW_BUCKET}" 2>/dev/null || echo "  Bucket ${NEW_BUCKET} already exists"

  # Mirror all objects
  mc mirror --preserve "${ALIAS}/${OLD_BUCKET}" "${ALIAS}/${NEW_BUCKET}"

  # Remove old bucket
  mc rb --force "${ALIAS}/${OLD_BUCKET}"

  echo "  Done"
done

echo ""
echo "MinIO bucket rename complete."
