#!/usr/bin/env bash
# ============================================================================
# Rebrand: Rename all kb-* Keycloak realms to basefyio-*
# ============================================================================
#
# Usage:
#   KEYCLOAK_URL=https://auth.basefyio.com \
#   KEYCLOAK_ADMIN=admin \
#   KEYCLOAK_ADMIN_PASSWORD=secret \
#   bash scripts/rebrand-rename-keycloak-realms.sh
#
# Keycloak does NOT support renaming a realm directly. This script:
#   1. Exports each kb-* realm as JSON
#   2. Creates a new basefyio-* realm with the same config
#   3. Deletes the old kb-* realm
#
# IMPORTANT: Run this AFTER the DB migration so the projects table already
# references the new realm names.
# ============================================================================

set -euo pipefail

KC_URL="${KEYCLOAK_URL:?Set KEYCLOAK_URL}"
KC_ADMIN="${KEYCLOAK_ADMIN:?Set KEYCLOAK_ADMIN}"
KC_PASS="${KEYCLOAK_ADMIN_PASSWORD:?Set KEYCLOAK_ADMIN_PASSWORD}"

# Get admin token
TOKEN=$(curl -sf -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=${KC_ADMIN}" \
  -d "password=${KC_PASS}" | jq -r '.access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: Failed to obtain Keycloak admin token"
  exit 1
fi

echo "Authenticated with Keycloak"

# List all realms starting with kb-
REALMS=$(curl -sf -H "Authorization: Bearer ${TOKEN}" "${KC_URL}/admin/realms" \
  | jq -r '.[].realm' | grep '^kb-' || true)

if [ -z "$REALMS" ]; then
  echo "No kb-* realms found. Nothing to do."
  exit 0
fi

echo "Found realms to rename:"
echo "$REALMS"
echo ""

for OLD_REALM in $REALMS; do
  NEW_REALM="basefyio-${OLD_REALM#kb-}"
  echo "--- Renaming: ${OLD_REALM} → ${NEW_REALM} ---"

  # Export the realm (partial export with clients, roles, etc.)
  EXPORT=$(curl -sf -H "Authorization: Bearer ${TOKEN}" \
    "${KC_URL}/admin/realms/${OLD_REALM}/partial-export?exportClients=true&exportGroupsAndRoles=true")

  if [ -z "$EXPORT" ]; then
    echo "  WARNING: Failed to export ${OLD_REALM}, skipping"
    continue
  fi

  # Update the realm name in the export JSON
  IMPORT=$(echo "$EXPORT" | jq --arg new "$NEW_REALM" '.realm = $new | .id = $new')

  # Create new realm
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST "${KC_URL}/admin/realms" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$IMPORT")

  if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "204" ]; then
    echo "  Created ${NEW_REALM}"

    # Delete old realm
    curl -sf -X DELETE "${KC_URL}/admin/realms/${OLD_REALM}" \
      -H "Authorization: Bearer ${TOKEN}"
    echo "  Deleted ${OLD_REALM}"
  else
    echo "  WARNING: Failed to create ${NEW_REALM} (HTTP ${HTTP_CODE}), keeping ${OLD_REALM}"
  fi
done

echo ""
echo "Keycloak realm rename complete."
