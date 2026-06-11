#!/usr/bin/env bash
# Fails if any non-legacy source file contains a 'kolaybase' brand string.
# Run in CI: bash scripts/check-rebrand.sh
set -euo pipefail

EXCLUDES=(
  "node_modules"
  ".git"
  "scripts/check-rebrand.sh"  # this file itself
  "configuration.ts"          # postgres/minio dev defaults
  "data-engine.service.ts"    # connection string fallback
  "infrastructure.service.ts" # docker network dev default
  "storage.service.ts"        # minio dev defaults
  "auth.service.ts"           # minio dev defaults (same pattern)
  "data-import.service.ts"    # minio dev defaults
  "data-import.processor.ts"  # minio dev defaults
  "resolve-env.spec.ts"       # test fixture strings for legacy-env fallback logic
  "package.json"              # VCS repo URLs and script names (not product brand strings)
  "package-lock.json"
  ".next"                     # Next.js build artifacts
  "graphify-out"              # knowledge graph cache
  "dist"                      # compiled output
  "*.md"
)

EXCLUDE_ARGS=()
for e in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=(--exclude="$e" --exclude-dir="$e")
done

if grep -r --include="*.ts" --include="*.js" --include="*.json" \
  "${EXCLUDE_ARGS[@]}" \
  -l "kolaybase" \
  apps/ packages/ 2>/dev/null | grep -v "node_modules" | grep -v "package-lock.json"; then
  echo "ERROR: Found kolaybase brand strings in source — run the rebrand script."
  exit 1
fi

echo "OK: No kolaybase brand strings found in source."
