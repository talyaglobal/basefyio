#!/usr/bin/env bash
# Assertions after `scripts/install.sh --yes --answers deploy/test/acceptance.env`
# on a clean machine: what runs, where it listens, which Keycloak, health,
# sign-in, a project, the direct Postgres role, and mail over SMTP from both
# the platform and Keycloak itself.
set -euo pipefail
cd "$(dirname "$0")/../.."

pass() { printf '\033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
envv() { python3 - "$1" <<'PY'
import sys, shlex
key = sys.argv[1]; val = ""
for line in open(".env", encoding="utf-8"):
    line = line.rstrip("\n")
    if line.startswith(key + "="):
        raw = line[len(key) + 1:]
        val = shlex.split(raw)[0] if raw.strip() else ""
print(val)
PY
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

API=http://127.0.0.1:4000/api
KC=http://127.0.0.1:8080

running="$(./basefyio ps --services --status running | sort | tr '\n' ' ')"
echo "running: $running"
for s in postgres keycloak minio redis redis-queue rabbitmq pgbouncer platform-api admin-ui website; do
  [[ " $running " == *" $s "* ]] || fail "$s is not running"
done
pass "core services run"
for s in nosql nosql-init mongodb couchdb; do
  [[ " $running " != *" $s "* ]] || fail "$s runs although the document store is off"
done
[ -z "$(docker ps -a --format '{{.Names}}' | grep -E 'nosql|mongodb|couchdb' || true)" ] || fail "a document-store container exists"
pass "no document store container"

pgb_ports="$(docker port "$(./basefyio ps -q pgbouncer)" 6432/tcp | sort -u | xargs)"
[ "$pgb_ports" = "127.0.0.1:6432" ] || fail "PgBouncer is published on: $pgb_ports"
pass "PgBouncer only on 127.0.0.1:6432"
pg_ports="$(docker port "$(./basefyio ps -q postgres)" 5432/tcp | sort -u | xargs)"
[ "$pg_ports" = "127.0.0.1:5432" ] || fail "Postgres is published on: $pg_ports"
pass "Postgres directly on 127.0.0.1:5432 only"

kc_image="$(docker inspect --format '{{.Config.Image}}' "$(./basefyio ps -q keycloak)")"
[[ "$kc_image" == *keycloak:26.* ]] || fail "Keycloak image is $kc_image"
pass "Keycloak $kc_image"

health="$(curl -sf "$API/health")"
echo "$health" | python3 -c '
import json, sys
h = json.load(sys.stdin); c = h["checks"]
print("health:", h["status"], {k: v.get("state") for k, v in c.items()}, "release:", h.get("release"))
bad = [k for k in ("database", "redis", "keycloak", "storage", "email") if c.get(k, {}).get("state") != "ok"]
sys.exit(1 if bad else 0)' || fail "health checks not ok"
pass "health: database, redis, keycloak (management port), storage and SMTP mail all ok"

[ "$(./basefyio exec -T platform-api printenv AI_ENABLED)" = "false" ] || fail "AI_ENABLED is not false in the API"
pass "AI switched off in the API"

# The direct role: databases and roles of its own, with connection-time
# settings PgBouncer's transaction mode refuses.
export PGPASSWORD=Acceptance-pass-1
psql "host=127.0.0.1 port=5432 user=marina_admin dbname=postgres options='-c TimeZone=UTC -c jit=off'" -v ON_ERROR_STOP=1 \
  -c "show timezone" -c "create database marina_one" -c "create role marina_one_app login password 'x'" \
  -c "grant connect on database marina_one to marina_one_app" >/dev/null || fail "the direct role cannot create a database and a role"
[ "$(psql "host=127.0.0.1 port=5432 user=marina_admin dbname=postgres" -Atc "select rolsuper from pg_roles where rolname='marina_admin'")" = "f" ] \
  || fail "marina_admin is a superuser"
pass "direct role creates databases and roles, sends -c options, and is not a superuser"
unset PGPASSWORD

# Platform sign-in as the bootstrap admin, then a project: a realm in Keycloak 26, a database, keys.
admin_user="$(envv KEYCLOAK_ADMIN_USER)"; admin_pw="$(envv KEYCLOAK_ADMIN_PASSWORD)"
login_body="$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))' "$admin_user" "$admin_pw")"
token="$(curl -sf -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "$login_body" | json 'd["accessToken"]')" \
  || fail "platform sign-in failed"
pass "platform sign-in through Keycloak 26"
team="$(curl -sf "$API/teams" -H "Authorization: Bearer $token" | json 'd[0]["id"]')"
project="$(curl -sf -X POST "$API/projects" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "{\"name\":\"acceptance\",\"teamId\":\"$team\",\"databaseType\":\"RELATIONAL\"}")" || fail "project creation failed"
realm="$(echo "$project" | json 'd.get("keycloakRealm", "")')"
[ -n "$realm" ] || fail "the project has no realm: $project"
pass "project created with realm $realm"

kc_token="$(curl -sf -X POST "$KC/realms/master/protocol/openid-connect/token" -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$admin_user" --data-urlencode "password=$admin_pw" | json 'd["access_token"]')"
smtp_host="$(curl -sf "$KC/admin/realms/$realm" -H "Authorization: Bearer $kc_token" | json 'd.get("smtpServer", {}).get("host", "")')"
[ "$smtp_host" = "mailpit" ] || fail "the project realm has SMTP host '$smtp_host'"
pass "the project realm sends Keycloak's own mail through the platform's SMTP server"

# Platform mail over SMTP: a sign-up code.
curl -sf -X POST "$API/auth/signup" -H 'Content-Type: application/json' \
  -d '{"email":"captain@example.test","password":"Captain-pass-1!","firstName":"Captain","lastName":"Test"}' >/dev/null \
  || fail "sign-up failed"
# Keycloak's own mail: an action e-mail from the project realm.
curl -sf -X POST "$KC/admin/realms/$realm/users" -H "Authorization: Bearer $kc_token" -H 'Content-Type: application/json' \
  -d '{"username":"crew@example.test","email":"crew@example.test","enabled":true,"firstName":"Crew","lastName":"Test","emailVerified":true}' >/dev/null
crew="$(curl -sf "$KC/admin/realms/$realm/users?email=crew@example.test&exact=true" -H "Authorization: Bearer $kc_token" | json 'd[0]["id"]')"
curl -sf -X PUT "$KC/admin/realms/$realm/users/$crew/execute-actions-email" -H "Authorization: Bearer $kc_token" \
  -H 'Content-Type: application/json' -d '["UPDATE_PASSWORD"]' >/dev/null || fail "Keycloak could not send its own mail"
sleep 5
inbox="$(curl -sf http://127.0.0.1:8025/api/v1/messages | json '" ".join(sorted({t["Address"] for m in d["messages"] for t in m["To"]}))')"
echo "mailpit received for: $inbox"
[[ " $inbox " == *" captain@example.test "* ]] || fail "the platform's sign-up mail did not arrive over SMTP"
[[ " $inbox " == *" crew@example.test "* ]] || fail "Keycloak's own mail did not arrive over SMTP"
pass "platform mail and Keycloak mail both delivered over SMTP"

echo
echo "All acceptance checks passed."
