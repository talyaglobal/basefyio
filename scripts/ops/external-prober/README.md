# External prober

The platform probes itself every 30 seconds, but a prober that lives on the same host cannot
see that host die. This container runs the same six probes from somewhere else and posts them to
`POST /api/platform-status/samples`, where the status page treats them like the internal ones
(a minute is down when the majority of vantage points failed).

## Run it

On any small machine with Docker (a €4/month cloud instance in another datacenter is enough):

```bash
docker build -t basefyio-external-prober scripts/ops/external-prober
docker run -d --name basefyio-external-prober --restart unless-stopped \
  -e PLATFORM_DOMAIN=basefyio.com \
  -e PROBE_TOKEN='<PLATFORM_STATUS_PROBE_TOKEN from the platform>' \
  -e VANTAGE=hel1-ext \
  -e CANARY_ANON_KEY='<anon key of the slo-canary project>' \
  -e CANARY_DB_URL='postgres://<user>:<password>@db.basefyio.com:6432/<db>?sslmode=require' \
  -e STORAGE_PROBE_URL='https://storage.basefyio.com/<bucket>/ok.txt' \
  basefyio-external-prober
```

The three canary variables are optional: without them only the API readiness, dashboard and
auth probes run. The values come from the console's Reliability page (the canary's ids are in the
`platform_status.canary` system setting). Samples are queued for up to ten minutes when the
platform cannot be reached, so an outage is recorded once it ends.
