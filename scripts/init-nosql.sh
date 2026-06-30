#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Basefyio — NoSQL Store (Couchbase) Initialization Script
#
# This script runs as a one-shot container after the nosql service
# is healthy. It:
#   1. Waits for the cluster to be reachable
#   2. Initializes the cluster (if not already initialized)
#   3. Creates the basefyio-apps bucket
#   4. Creates the 'projects' scope
#   5. Creates the 'records' collection
#   6. Creates baseline indexes
#
# Idempotent — safe to run multiple times.
# ──────────────────────────────────────────────────────────────

set -euo pipefail

CB_HOST="${CB_HOST:-nosql}"
CB_PORT="${CB_PORT:-8091}"
CB_USER="${CB_USER:-basefyio}"
CB_PASS="${CB_PASS:-basefyio_secret}"
BUCKET="${DATA_ENGINE_CONTAINER:-basefyio-apps}"
SCOPE="${DATA_ENGINE_NAMESPACE:-projects}"
COLLECTION="records"
BUCKET_RAM="${CB_BUCKET_RAM_MB:-256}"

BASE_URL="http://${CB_HOST}:${CB_PORT}"

echo "==> Waiting for Couchbase to be reachable at ${BASE_URL}..."
for i in $(seq 1 60); do
  # Try with auth first (cluster already initialized), then without (fresh cluster)
  if curl -sf -u "${CB_USER}:${CB_PASS}" "${BASE_URL}/pools" > /dev/null 2>&1; then
    echo "    Couchbase is reachable (authenticated)."
    break
  elif curl -sf "${BASE_URL}/pools" > /dev/null 2>&1; then
    echo "    Couchbase is reachable (fresh cluster)."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "    ERROR: Couchbase not reachable after 60 attempts. Aborting."
    exit 1
  fi
  sleep 2
done

# ── Step 1: Initialize Cluster ──────────────────────────────

echo "==> Checking if cluster is already initialized..."
POOL_STATUS=$(curl -sf "${BASE_URL}/pools" | grep -o '"status":"[^"]*"' | head -1 || echo "")

if echo "$POOL_STATUS" | grep -q "healthy"; then
  echo "    Cluster already initialized."
else
  echo "    Initializing cluster..."

  # Set memory quotas
  curl -sf -X POST "${BASE_URL}/pools/default" \
    -d "memoryQuota=${BUCKET_RAM}" \
    -d "indexMemoryQuota=256" \
    -d "ftsMemoryQuota=256" || true

  # Set services (data + index + query)
  curl -sf -X POST "${BASE_URL}/node/controller/setupServices" \
    -d "services=kv%2Cn1ql%2Cindex" || true

  # Set admin credentials
  curl -sf -X POST "${BASE_URL}/settings/web" \
    -d "password=${CB_PASS}" \
    -d "username=${CB_USER}" \
    -d "port=SAME" || true

  # Set index storage mode
  curl -sf -X POST "${BASE_URL}/settings/indexes" \
    -u "${CB_USER}:${CB_PASS}" \
    -d "storageMode=plasma" || \
  curl -sf -X POST "${BASE_URL}/settings/indexes" \
    -u "${CB_USER}:${CB_PASS}" \
    -d "storageMode=forestdb" || true

  echo "    Cluster initialized."
fi

# ── Step 2: Create Bucket ────────────────────────────────────

echo "==> Checking bucket '${BUCKET}'..."
BUCKET_EXISTS=$(curl -sf -u "${CB_USER}:${CB_PASS}" "${BASE_URL}/pools/default/buckets/${BUCKET}" 2>&1 || echo "NOT_FOUND")

if echo "$BUCKET_EXISTS" | grep -q "NOT_FOUND\|not found\|Requested resource not found"; then
  echo "    Creating bucket '${BUCKET}' with ${BUCKET_RAM}MB RAM..."
  curl -sf -X POST "${BASE_URL}/pools/default/buckets" \
    -u "${CB_USER}:${CB_PASS}" \
    -d "name=${BUCKET}" \
    -d "ramQuota=${BUCKET_RAM}" \
    -d "bucketType=couchbase" \
    -d "flushEnabled=0"
  echo "    Bucket created. Waiting for it to be ready..."
  sleep 5
else
  echo "    Bucket '${BUCKET}' already exists."
fi

# Wait for bucket to be warm
for i in $(seq 1 30); do
  STATUS=$(curl -sf -u "${CB_USER}:${CB_PASS}" "${BASE_URL}/pools/default/buckets/${BUCKET}" | grep -o '"status":"[^"]*"' | head -1 || echo "")
  if echo "$STATUS" | grep -q "healthy"; then
    echo "    Bucket is healthy."
    break
  fi
  sleep 2
done

# ── Step 3: Create Scope ─────────────────────────────────────

echo "==> Checking scope '${SCOPE}'..."
SCOPES=$(curl -sf -u "${CB_USER}:${CB_PASS}" \
  "${BASE_URL}/pools/default/buckets/${BUCKET}/scopes" 2>&1 || echo "{}")

if echo "$SCOPES" | grep -q "\"name\":\"${SCOPE}\""; then
  echo "    Scope '${SCOPE}' already exists."
else
  echo "    Creating scope '${SCOPE}'..."
  curl -sf -X POST "${BASE_URL}/pools/default/buckets/${BUCKET}/scopes" \
    -u "${CB_USER}:${CB_PASS}" \
    -d "name=${SCOPE}"
  echo "    Scope created."
  sleep 2
fi

# ── Step 4: Create Collection ─────────────────────────────────

echo "==> Checking collection '${SCOPE}.${COLLECTION}'..."
if echo "$SCOPES" | grep -q "\"name\":\"${COLLECTION}\""; then
  echo "    Collection '${COLLECTION}' already exists."
else
  echo "    Creating collection '${COLLECTION}' in scope '${SCOPE}'..."
  curl -sf -X POST "${BASE_URL}/pools/default/buckets/${BUCKET}/scopes/${SCOPE}/collections" \
    -u "${CB_USER}:${CB_PASS}" \
    -d "name=${COLLECTION}"
  echo "    Collection created."
  sleep 3
fi

# ── Step 5: Create Baseline Indexes ──────────────────────────

echo "==> Creating baseline indexes..."

N1QL_URL="http://${CB_HOST}:8093/query/service"

# Primary index (for dev/small workloads — drop in production if not needed)
curl -sf -X POST "${N1QL_URL}" \
  -u "${CB_USER}:${CB_PASS}" \
  -d "statement=CREATE PRIMARY INDEX IF NOT EXISTS \`idx_primary\` ON \`${BUCKET}\`.\`${SCOPE}\`.\`${COLLECTION}\` USING GSI" \
  2>/dev/null || echo "    (primary index may already exist or query service not ready yet)"

# _projectId + _entity compound index (most common query pattern)
curl -sf -X POST "${N1QL_URL}" \
  -u "${CB_USER}:${CB_PASS}" \
  -d "statement=CREATE INDEX IF NOT EXISTS \`idx_project_entity\` ON \`${BUCKET}\`.\`${SCOPE}\`.\`${COLLECTION}\`(\`_projectId\`, \`_entity\`) USING GSI" \
  2>/dev/null || echo "    (compound index may need query service)"

# _projectId + _entity + _status (active record queries)
curl -sf -X POST "${N1QL_URL}" \
  -u "${CB_USER}:${CB_PASS}" \
  -d "statement=CREATE INDEX IF NOT EXISTS \`idx_project_entity_status\` ON \`${BUCKET}\`.\`${SCOPE}\`.\`${COLLECTION}\`(\`_projectId\`, \`_entity\`, \`_status\`) USING GSI" \
  2>/dev/null || echo "    (status index may need query service)"

# _projectId + _entity + _createdAt (feed/timeline queries)
curl -sf -X POST "${N1QL_URL}" \
  -u "${CB_USER}:${CB_PASS}" \
  -d "statement=CREATE INDEX IF NOT EXISTS \`idx_project_entity_created\` ON \`${BUCKET}\`.\`${SCOPE}\`.\`${COLLECTION}\`(\`_projectId\`, \`_entity\`, \`_createdAt\` DESC) USING GSI" \
  2>/dev/null || echo "    (created_at index may need query service)"

echo ""
echo "==> NoSQL store initialization complete!"
echo "    Bucket:     ${BUCKET}"
echo "    Scope:      ${SCOPE}"
echo "    Collection: ${COLLECTION}"
echo "    Indexes:    idx_primary, idx_project_entity, idx_project_entity_status, idx_project_entity_created"
echo ""
