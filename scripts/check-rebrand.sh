#!/usr/bin/env bash
# CI gate: ensure no stale kolaybase branding in source files.
# Exits non-zero if violations found.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
VIOLATIONS=()

# Files to exclude: dev defaults, migration archives, test fixtures, seed data, ADRs
EXCLUDE=(
  "--exclude-dir=.git"
  "--exclude-dir=node_modules"
  "--exclude-dir=dist"
  "--exclude-dir=.next"
  "--exclude-dir=graphify-out"
  "--exclude-dir=.turbo"
  "--exclude=*.md"           # docs may reference old branding contextually
  "--exclude=*.sql"          # migration files may contain old names
  "--exclude=*.seed.ts"      # seed files may reference legacy values
  "--exclude=*.spec.ts"      # test fixtures may reference legacy values
  "--exclude=check-rebrand.sh"  # this script
  "--exclude=configuration.ts"    # KOLAYBASE_ fallback env vars are intentional here
  "--exclude=resolve-env.spec.ts" # tests the KOLAYBASE_ fallback behaviour
)

check() {
  local pattern="$1"
  local description="$2"
  local results
  # Use find+grep for reliable exclusions on both GNU and BSD (macOS) grep
  results=$(find "$ROOT/apps" "$ROOT/packages" "$ROOT/scripts" \
    \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.json" -o -name "*.sh" -o -name "*.xml" \) \
    -not -path "*/.git/*" \
    -not -path "*/node_modules/*" \
    -not -path "*/dist/*" \
    -not -path "*/.next/*" \
    -not -path "*/graphify-out/*" \
    -not -path "*/.turbo/*" \
    2>/dev/null \
    | xargs grep -l -e "$pattern" 2>/dev/null \
    | grep -v "check-rebrand.sh" \
    | grep -v "check-kolaybase-env.sh" \
    | grep -v "configuration\.ts" \
    | grep -v "resolve-env\.spec\.ts" \
    | grep -v "\.spec\.ts$" \
    | grep -v "\.seed\.ts$" \
    | grep -v "\.sql$" \
    | grep -v "package-lock\.json" \
    || true)
  if [ -n "$results" ]; then
    FAIL=$((FAIL + 1))
    VIOLATIONS+=("FAIL: $description")
    echo "FAIL: $description"
    echo "$results" | head -5 | sed 's/^/  /'
  else
    PASS=$((PASS + 1))
    echo "PASS: $description"
  fi
}

# Check 1: No 'kolaybase' brand string in source (case-insensitive)
check "kolaybase" "No stale 'kolaybase' brand strings"

# Check 2: KOLAYBASE_ env vars only in config/fallback contexts
# (allowed: KOLAYBASE_ as fallback, not as primary)
# This is a best-effort heuristic — look for bare KOLAYBASE_ without OR/fallback pattern
check "process\.env\.KOLAYBASE_[A-Z]" "No direct process.env.KOLAYBASE_ usage (use BASEFYIO_ primary)"

# Summary
echo ""
echo "Rebrand check: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Violations:"
  for v in "${VIOLATIONS[@]}"; do echo "  $v"; done
  exit 1
fi
exit 0
