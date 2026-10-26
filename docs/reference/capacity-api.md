# Capacity API (`/api/admin/capacity`)

What the root console's **Capacity** page reads: how loaded every resource is, how many more
projects fit at today's usage profile, and what a hypothetical platform would do. Every route
needs a ROOT session, except the benchmark upload, which takes a token.

## How the numbers are made

- **Sampler** (`CAPACITY_SAMPLER_ENABLED=true`): once a minute on the scheduler leader, one row
  (`capacity_samples`, kept 30 days; hourly means in `capacity_rollups` for good) with the host's
  kernel counters (`/host/proc`, falling back to the container's own view), the `kolaybase-*`
  containers' CPU and memory, the data volume and the storage autopilot's thresholds, Postgres
  (`pg_stat_activity` by state, `max_connections`, commits per minute, cache hit ratio,
  deadlocks), the pooler (`SHOW POOLS`: pools, client and server connections), Redis (`INFO`:
  memory, keys, evictions), the API (in-flight requests, requests per second and the 5xx share
  from the request histograms, the day's p95 from the availability probes, realtime clients) and
  the tenancy counts (organizations, paying organizations, projects by status, projects due to be
  deactivated).
- **Model** (every 5 minutes; a snapshot stored hourly in `capacity_model_snapshots`): for each
  resource, usage is a fixed overhead plus a per-project cost; projects that are deactivated cost
  only disk. The ceilings are what was read (`max_connections`, host cores and memory, the
  volume, Redis `maxmemory`, the pooler's `max_client_conn`) and, for API throughput, the latest
  green `rest-read` or `mixed-tenant` benchmark per replica (a conservative placeholder until one
  exists). Capacity is the smallest "projects until the target" across resources, at today's
  awake share and again with every project awake; organizations follow from projects per paying
  organization. Until the sampler has half a day of data the per-project profile is a seed and
  the page says so.
- **Alerts** (console red bar): headroom under 15 % (critical under 5 %), a resource above its
  target for 30 minutes, Redis evictions.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/capacity/overview` | the whole page: latest sample, model, recommendations, ceilings, per-project profile, presets, benchmark state, 24-hour sparklines |
| GET | `/api/admin/capacity/model` | the model and recommendations only |
| GET | `/api/admin/capacity/model/history?days=90` | hourly snapshots: `maxProjects`, `maxProjectsAllAwake`, `currentProjects`, `bottleneck` |
| GET | `/api/admin/capacity/samples?from&to&step=5` | raw samples at a step in minutes |
| POST | `/api/admin/capacity/simulate` | `{ projects, awakeShare, rpsPerProject, dbConnectionsPerProject, dbGbPerProject, storageGbPerProject, sseClientsPerProject, apiReplicas, nodes?, ceilings? }` → utilization per resource, the first saturated one, the project count at which each saturates, the cheapest next step |
| GET | `/api/admin/capacity/recommendations` | plain-English findings from the model |
| GET / POST | `/api/admin/capacity/scenarios` | saved simulation inputs (`SystemSetting` `capacity.scenarios`, at most 20) |
| GET | `/api/admin/capacity/benchmarks` | the benchmark ledger |
| POST | `/api/admin/capacity/benchmarks/results` | token (`CAPACITY_BENCHMARK_TOKEN`): `{ scenario, target, params?, result: { rps, p50, p95, p99, errorRate, byStage? }, startedAt?, finishedAt? }` |
| POST | `/api/admin/capacity/sample` | take one sample now (useful while the sampler is off) |

Scenarios the runner should use: `rest-read`, `rest-write`, `sql-execute`, `auth-signin`,
`storage-download`, `realtime-connect`, `mixed-tenant`, `wake-storm` (never against production).
