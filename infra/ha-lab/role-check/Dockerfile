# pg-role-check for the HA lab (never deployed). Answers like Patroni's REST
# API on :8008 so the HAProxy checks stay the same when Patroni arrives:
#   GET /primary           200 when the node is not in recovery, else 503
#   GET /replica[?lag=N]   200 when the node is in recovery, its WAL receiver
#                          is streaming and replay is <= N bytes behind
#                          receive (default: no lag limit), else 503
#   GET /health            200 when the node accepts connections
# Anything that cannot reach Postgres answers 503, so HAProxy marks it down.
FROM alpine:3.20.10@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache bash socat postgresql16-client
COPY role-check.sh /usr/local/bin/role-check.sh
RUN chmod 0755 /usr/local/bin/role-check.sh
USER nobody
EXPOSE 8008
ENTRYPOINT ["/bin/sh", "-c", "exec socat -T 5 TCP-LISTEN:${CHECK_PORT:-8008},reuseaddr,fork EXEC:/usr/local/bin/role-check.sh"]
