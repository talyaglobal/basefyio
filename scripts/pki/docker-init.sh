#!/bin/sh
# scripts/pki/docker-init.sh — OpenBao dev-mode bootstrap for docker-compose
#
# Runs once on first compose up. Idempotent: mount-already-exists errors are ignored.
# Dev-mode root token: dev-only-root-token  (never use in prod)
#
# What this configures:
#   1. PKI secrets engine (pki mount, root CA, basefyio-client role)
#   2. KV v2 secrets engine (secret mount)
#
# For production/real staging setup, follow docs/runbooks/openbao-pki-e2e.md §1.

set -eu

VAULT_ADDR="${VAULT_ADDR:-http://openbao:8200}"
TOKEN="${OPENBAO_ROOT_TOKEN:-dev-only-root-token}"

log() { echo "[openbao-init] $*"; }

# ── Wait for OpenBao ──────────────────────────────────────────────────────────
log "Waiting for OpenBao at $VAULT_ADDR ..."
i=0
until curl -sf "$VAULT_ADDR/v1/sys/health" > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    log "ERROR: OpenBao did not become ready after 60s"
    exit 1
  fi
  sleep 2
done
log "OpenBao is up"

# ── PKI secrets engine ────────────────────────────────────────────────────────
log "Enabling PKI secrets engine..."
curl -sf -X POST \
  -H "X-Vault-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"pki"}' \
  "$VAULT_ADDR/v1/sys/mounts/pki" > /dev/null 2>&1 || log "  pki mount already exists (ok)"

curl -sf -X POST \
  -H "X-Vault-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"max_lease_ttl":"87600h"}' \
  "$VAULT_ADDR/v1/sys/mounts/pki/tune" > /dev/null

log "Generating root CA..."
curl -sf -X POST \
  -H "X-Vault-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"common_name":"basefyio-dev-ca","ttl":"87600h"}' \
  "$VAULT_ADDR/v1/pki/root/generate/internal" > /dev/null

curl -sf -X POST \
  -H "X-Vault-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"issuing_certificates\":\"$VAULT_ADDR/v1/pki/ca\",\"crl_distribution_points\":\"$VAULT_ADDR/v1/pki/crl\",\"ocsp_servers\":\"$VAULT_ADDR/v1/pki/ocsp\"}" \
  "$VAULT_ADDR/v1/pki/config/urls" > /dev/null

log "Creating PKI role basefyio-client..."
curl -sf -X POST \
  -H "X-Vault-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"allowed_domains":"basefyio.com","allow_subdomains":true,"max_ttl":"8760h","key_type":"rsa","key_bits":2048,"require_cn":true}' \
  "$VAULT_ADDR/v1/pki/roles/basefyio-client" > /dev/null

# ── KV v2 secrets engine ──────────────────────────────────────────────────────
log "Enabling KV v2 secrets engine..."
curl -sf -X POST \
  -H "X-Vault-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"kv","options":{"version":"2"}}' \
  "$VAULT_ADDR/v1/sys/mounts/secret" > /dev/null 2>&1 || log "  secret mount already exists (ok)"

log "OpenBao bootstrap complete — PKI + KV v2 ready"
