#!/usr/bin/env bash
# Load an image bundle made by scripts/bundle-images.sh on an air-gapped host.
#
#   ./scripts/load-images.sh basefyio-images-20261020.tar.gz
#
# Verifies the checksum when the .sha256 file sits next to the bundle, loads
# every image, then checks that each name in the bundle's manifest is present —
# a truncated transfer shows up here, not as a failing container later. Nothing
# is pulled: this host is expected to have no registry access.
set -euo pipefail

BUNDLE="${1:-}"
if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  echo "usage: scripts/load-images.sh <basefyio-images-YYYYMMDD.tar.gz>" >&2
  exit 1
fi

BUNDLE_DIR="$(dirname "$BUNDLE")"
BUNDLE_NAME="$(basename "$BUNDLE")"

if [ -f "$BUNDLE.sha256" ]; then
  echo "==> Verifying checksum"
  (cd "$BUNDLE_DIR" && sha256sum -c "$BUNDLE_NAME.sha256")
else
  echo "==> No $BUNDLE_NAME.sha256 next to the bundle — skipping checksum"
fi

echo "==> Loading images"
gunzip -c "$BUNDLE" | docker load

LIST="${BUNDLE%.tar.gz}.images.txt"
if [ -f "$LIST" ]; then
  echo "==> Checking the manifest"
  missing=0
  while IFS= read -r img; do
    [ -z "$img" ] && continue
    if docker image inspect "$img" >/dev/null 2>&1; then
      echo "    ok      $img"
    else
      echo "    MISSING $img" >&2
      missing=1
    fi
  done < "$LIST"
  if [ "$missing" != 0 ]; then
    echo "bundle is incomplete — rebuild it with scripts/bundle-images.sh and copy it again" >&2
    exit 1
  fi
else
  echo "==> No manifest ($LIST) next to the bundle — skipping completeness check"
fi

echo "==> Loaded. Start the stack without touching a registry:"
echo "    COMPOSE_PROJECT_NAME=\${COMPOSE_PROJECT_NAME:-basefyio} docker compose [--profile tls] up -d --pull never"
