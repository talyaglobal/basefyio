#!/usr/bin/env bash
# Excel→App end-to-end demo script
# Demonstrates the full flow: analyze → review → approve → generate → status
# Prerequisites: platform-api running on localhost:3000, valid JWT in $DEMO_TOKEN
#
# Usage: DEMO_TOKEN=<jwt> ./scripts/demo-excel-to-app.sh

set -euo pipefail

API="${DEMO_API_URL:-http://localhost:3000}"
TOKEN="${DEMO_TOKEN:-demo-token}"
TEAM_ID="${DEMO_TEAM_ID:-team-demo-1}"

h() { echo -e "\n\033[1;36m=== $1 ===\033[0m"; }
ok() { echo -e "\033[1;32m✓ $1\033[0m"; }
fail() { echo -e "\033[1;31m✗ $1\033[0m"; exit 1; }

h "Step 1: Analyze Excel data"
ANALYZE_RESPONSE=$(curl -sf -X POST "$API/v1/blueprints/analyze" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "teamId": "'"$TEAM_ID"'",
    "sheets": [
      {
        "sheet": "Customers",
        "headers": ["Name", "Email", "Phone", "Country"],
        "sampleRows": [
          ["Alice Smith", "alice@example.com", "+1-555-0100", "US"],
          ["Bob Jones", "bob@example.com", "+44-20-1234", "UK"]
        ]
      },
      {
        "sheet": "Orders",
        "headers": ["Order ID", "Customer Email", "Amount", "Status", "Created At"],
        "sampleRows": [
          ["ORD-001", "alice@example.com", "299.99", "completed", "2026-01-15"],
          ["ORD-002", "bob@example.com", "149.50", "pending", "2026-01-16"]
        ]
      }
    ]
  }')

BLUEPRINT_ID=$(echo "$ANALYZE_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
DOMAIN=$(echo "$ANALYZE_RESPONSE" | grep -o '"domain":"[^"]*"' | cut -d'"' -f4)

if [ -z "$BLUEPRINT_ID" ]; then
  fail "Analyze failed. Response: $ANALYZE_RESPONSE"
fi

ok "Blueprint created: $BLUEPRINT_ID (domain: $DOMAIN)"

h "Step 2: Review Blueprint"
curl -sf "$API/v1/blueprints/$BLUEPRINT_ID" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys, json
bp = json.load(sys.stdin)
dm = bp.get('dataModel', {})
tables = dm.get('tables', [])
print(f\"  Tables: {', '.join(t['name'] for t in tables)}\")
print(f\"  Status: {bp.get('status')}\")
" 2>/dev/null || echo "  (review: python3 not available)"

h "Step 3: Approve Blueprint"
APPROVE_RESPONSE=$(curl -sf -X PATCH "$API/v1/blueprints/$BLUEPRINT_ID/approve" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My CRM App", "navigation": [], "roles": []}')
ok "Blueprint approved: $(echo "$APPROVE_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)"

h "Step 4: Generate App (async)"
GENERATE_RESPONSE=$(curl -sf -X POST "$API/v1/blueprints/$BLUEPRINT_ID/generate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')
JOB_ID=$(echo "$GENERATE_RESPONSE" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
ok "Generation job queued: $JOB_ID"

h "Step 5: Poll for completion"
MAX_POLLS=15
for i in $(seq 1 $MAX_POLLS); do
  STATUS_RESPONSE=$(curl -sf "$API/v1/blueprints/$BLUEPRINT_ID/status" \
    -H "Authorization: Bearer $TOKEN")
  STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  PROJECT_ID=$(echo "$STATUS_RESPONSE" | grep -o '"projectId":"[^"]*"' | cut -d'"' -f4)
  echo "  Poll $i/$MAX_POLLS: status=$STATUS"
  if [ "$STATUS" = "generated" ]; then
    ok "App generated! Project ID: $PROJECT_ID"
    break
  elif [ "$STATUS" = "error" ]; then
    fail "Generation failed"
  fi
  sleep 3
done

h "Step 6: Ask a question (NL→SQL)"
ASK_RESPONSE=$(curl -sf -X POST "$API/v1/intelligence/ask" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"question\": \"How many customers do we have?\", \"projectId\": \"${PROJECT_ID:-unknown}\"}" 2>/dev/null || echo '{"sql":"N/A","rowCount":0}')
echo "  SQL: $(echo "$ASK_RESPONSE" | grep -o '"sql":"[^"]*"' | cut -d'"' -f4)"
echo "  Row count: $(echo "$ASK_RESPONSE" | grep -o '"rowCount":[0-9]*' | cut -d':' -f2)"

h "Demo complete"
echo "  Blueprint ID: $BLUEPRINT_ID"
echo "  Project ID:   ${PROJECT_ID:-<pending>}"
echo ""
echo "  Next steps:"
echo "  - Open nfyio-runtime: cd apps/nfyio-runtime && npm run dev"
echo "  - Open admin-ui: cd apps/admin-ui && npm run dev"
echo "  - Blueprint editor: /dashboard/blueprints/$BLUEPRINT_ID"
