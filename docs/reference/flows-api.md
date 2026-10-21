# Flows API (`/api/projects/:projectId/flows`)

A flow is a named trigger plus an ordered list of actions, run on the platform's background
job queue. Today a flow is started by calling its `trigger` route; each run is recorded with
the result of every step.

## Authentication

Service key (`apikey`) or a dashboard session. The anon key is refused with 403.

## Routes

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/flows` | service | list flows |
| POST | `/api/projects/:projectId/flows` | service | create |
| GET | `/api/projects/:projectId/flows/:id` | service | one flow |
| PATCH | `/api/projects/:projectId/flows/:id` | service | replace the definition |
| DELETE | `/api/projects/:projectId/flows/:id` | service | delete → `{ deleted: true }` |
| POST | `/api/projects/:projectId/flows/:id/enable` | service | enable |
| POST | `/api/projects/:projectId/flows/:id/disable` | service | disable |
| POST | `/api/projects/:projectId/flows/:id/trigger` | service | run now — body `{ "input": … }` optional → `{ runId, status }` |
| GET | `/api/projects/:projectId/flows/:id/runs` | service | the last 50 runs, newest first |

## Definition

```json
{
  "name": "Notify on signup",
  "trigger": { "type": "manual" },
  "actions": [
    { "type": "log", "message": "new signup" },
    { "type": "http.request", "method": "POST", "url": "https://hooks.example.com/signup",
      "headers": { "Content-Type": "application/json" }, "body": { "source": "basefyio" },
      "continueOnError": false }
  ],
  "enabled": true
}
```

| Field | Rules |
|---|---|
| `name` | required |
| `trigger.type` | `manual`, `webhook` or `schedule`. Only `manual` has a way to fire today: `webhook` (`webhookPath`) and `schedule` (`cron`) are accepted and stored, but no receiver or scheduler runs them yet |
| `actions` | at least one; each `type` is `log` (`message`) or `http.request` (`method`, `url`, `headers?`, `body?`) |
| `continueOnError` | per action; otherwise a failing action stops the run |

An `http.request` URL is checked when it runs: loopback, private and link-local addresses and
the platform's own container names are refused, so a flow cannot be used to reach internal
services. A flow that is disabled cannot be triggered (400 `Flow is disabled`).

A flow row: `{ id, projectId, name, enabled, trigger, actions, createdAt, updatedAt }`. A run
records its status, the input it was given and one `{ type, ok, status?, detail? }` per action.

## Example

```bash
FLOW=$(curl -s $API/projects/$PROJECT_ID/flows -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \
  -d '{"name":"ping","trigger":{"type":"manual"},"actions":[{"type":"http.request","method":"GET","url":"https://example.com/health"}]}' | jq -r .id)
curl -s -X POST $API/projects/$PROJECT_ID/flows/$FLOW/trigger -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" -d '{"input":{"reason":"test"}}'
curl -s $API/projects/$PROJECT_ID/flows/$FLOW/runs -H "apikey: $SERVICE_KEY"
```

## Errors

| Status | When |
|---|---|
| 400 | `name is required`; `trigger.type must be one of manual, webhook, schedule`; `at least one action is required`; `action.type must be one of log, http.request`; `http.request action requires a url`; `Flow is disabled` |
| 403 | anon key; not a member of the project's team |
| 404 | `Flow not found` |

Source: `apps/platform-api/src/modules/flows/flows.controller.ts`, `flows.service.ts`,
`flow.types.ts`, `flow-url-guard.ts`, `flow-execute.processor.ts`; Prisma models `Flow`, `FlowRun`.
