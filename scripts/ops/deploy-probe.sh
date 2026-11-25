#!/usr/bin/env bash
# Measure a deploy from the outside: every second, the sign-in page, the dashboard, the API health
# route and the website are requested; every answer is logged with its time.
#
#   scripts/ops/deploy-probe.sh start <logfile> [seconds]   run it in the background BEFORE pushing to production
#   scripts/ops/deploy-probe.sh report <logfile>            count the answers; list every one that is not 2xx/3xx
#
# The uptime target is 99.99% (docs/ops/zero-downtime-deploys.md): any answer in the report is an
# incident to explain. Hosts default to basefyio.com; set DOMAIN for another install.
set -uo pipefail
DOMAIN="${DOMAIN:-basefyio.com}"

case "${1:-}" in
  start)
    out="${2:?logfile}"; secs="${3:-900}"; : > "$out"
    end=$((SECONDS + secs))
    while [ "$SECONDS" -lt "$end" ]; do
      for t in "app https://app.$DOMAIN/login" "dash https://app.$DOMAIN/dashboard" "api https://api.$DOMAIN/api/health" "site https://$DOMAIN/"; do
        set -- $t
        code=$(curl -s -o /dev/null -m 4 -w '%{http_code}' "$2" 2>/dev/null)
        echo "$(date +%s) ${code:-000} $1" >> "$out"
      done
      sleep 0.6
    done
    ;;
  report)
    out="${2:?logfile}"
    python3 - "$out" <<'PY'
import collections, datetime, sys
rows = [l.split() for l in open(sys.argv[1]) if len(l.split()) == 3]
if not rows:
    sys.exit("no answers logged")
t = lambda e: datetime.datetime.fromtimestamp(int(e), datetime.timezone.utc).strftime('%H:%M:%S')
print(f"{len(rows)} answers, {t(rows[0][0])} to {t(rows[-1][0])} UTC")
c = collections.Counter((r[2], r[1]) for r in rows)
for k in sorted(c):
    print(f"  {k[0]:5} {k[1]} x{c[k]}")
bad = [r for r in rows if r[1][0] not in '23']
print(f"not 2xx/3xx: {len(bad)}")
for r in bad:
    print(f"  {t(r[0])} {r[1]} {r[2]}")
PY
    ;;
  *)
    echo "usage: $0 start <logfile> [seconds] | report <logfile>" >&2; exit 64 ;;
esac
