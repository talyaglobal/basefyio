#!/usr/bin/env bash
# CI gate: block new KOLAYBASE_* env-var references in TypeScript source.
#
# BASEFYIO_* is the canonical prefix. KOLAYBASE_* is allowed ONLY in the two
# designated legacy-fallback files listed below. Any other usage is a rebrand
# regression and will fail CI.
#
# Usage:  bash scripts/check-kolaybase-env.sh
#         Returns exit code 0 (pass) or 1 (violations found).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Files where KOLAYBASE_* is intentionally allowed as a legacy fallback.
ALLOWLIST=(
  "packages/sdk/src/lib/env.ts"
  "packages/cli/src/commands/db.ts"
)

# Match only DIRECT env-var accesses:
#   process.env.KOLAYBASE_*     process.env['KOLAYBASE_*']
#   env.KOLAYBASE_*
# This deliberately skips string literals like resolveEnv('BASEFYIO_X', 'KOLAYBASE_X')
# and doc comments — only runtime reads are blocked outside the allowlist.
PATTERN='(process\.env\.KOLAYBASE_|process\.env\[.KOLAYBASE_|env\.KOLAYBASE_)'

# Run grep across all .ts files (not node_modules / dist / graphify-out)
RAW=$(grep -rEn "$PATTERN" \
  --include="*.ts" \
  --exclude-dir="node_modules" \
  --exclude-dir="dist" \
  --exclude-dir="graphify-out" \
  --exclude-dir=".git" \
  "$REPO_ROOT" 2>/dev/null || true)

if [[ -z "$RAW" ]]; then
  echo "✓ No KOLAYBASE_* env references found."
  exit 0
fi

# Filter out the allowlisted files
VIOLATIONS=""
while IFS= read -r line; do
  allowed=false
  for f in "${ALLOWLIST[@]}"; do
    if echo "$line" | grep -qF "$f"; then
      allowed=true
      break
    fi
  done
  if [[ "$allowed" == "false" ]]; then
    VIOLATIONS+="$line"$'\n'
  fi
done <<< "$RAW"

if [[ -z "$VIOLATIONS" ]]; then
  echo "✓ KOLAYBASE_* usage found only in allowed fallback files."
  exit 0
fi

echo "✗ KOLAYBASE_* env references outside the approved fallback allowlist:"
echo ""
echo "$VIOLATIONS"
echo "Use BASEFYIO_* for new code. KOLAYBASE_* is only permitted in:"
for f in "${ALLOWLIST[@]}"; do
  echo "  - $f"
done
exit 1
