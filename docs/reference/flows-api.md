# Flows API (`/api/projects/:projectId/flows`)

A flow is a named trigger plus an ordered list of actions, run on the platform's background
job queue. Flows can be started manually, on a cron schedule, or by an external webhook.
Each run is recorded with the result of every step.

## Authentication

Management routes require a service key (`apikey`) or a dashboard session. The anon key is
refused with 403. The public webhook ingress (`/api/webhooks/flows/:flowId`) uses per-flow
HMAC-SHA256 — no API key needed.

## Management routes

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
| POST | `/api/projects/:projectId/flows/:id/rotate-webhook-secret` | service | rotate the HMAC secret → `{ webhookSecret }` |
| GET | `/api/projects/:projectId/flows/:id/runs` | service | the last 50 runs, newest first |

## Webhook ingress

External systems (GitHub, Stripe, custom scripts) fire a webhook flow by calling:

```
POST /api/webhooks/flows/:flowId
x-basefyio-signature: sha256=<HMAC-SHA256 hex over the raw request body>
Content-Type: application/json

{ ...your payload... }
```

No API key is required. Authentication is the per-flow HMAC secret.

**Signing example (Node.js):**

```js
const crypto = require('crypto');
const sig = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET)
  .update(rawBody)
  .digest('hex');
// then set header: x-basefyio-signature: sig
```

The secret is returned once when the flow is created (`webhookSecret` in the response body).
Rotate it at any time with `POST .../rotate-webhook-secret`. The response body is forwarded
as `input` to the flow run.

## Definition

```json
{
  "name": "Notify on signup",
  "trigger": { "type": "webhook" },
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
| `trigger.type` | `manual`, `webhook` or `schedule` |
| `trigger.cron` | required when `type` is `schedule`; standard 5-field cron |
| `actions` | at least one; each `type` is `log` (`message`) or `http.request` (`method`, `url`, `headers?`, `body?`) |
| `continueOnError` | per action; otherwise a failing action stops the run |

A webhook flow is assigned a random 32-byte HMAC secret on creation.
The secret is returned once in the create response (`webhookSecret`); subsequent reads return
`webhookSecretConfigured: true` without exposing the value.
Header values whose key matches `Authorization`, `X-Api-Key` or similar sensitive patterns
are masked as `***` in read responses.

An `http.request` URL is checked when it runs: loopback, private and link-local addresses and
the platform's own container names are refused, so a flow cannot be used to reach internal
services. A flow that is disabled cannot be triggered (400 `Flow is disabled`).

A flow row: `{ id, projectId, name, enabled, trigger, actions, webhookSecretConfigured, createdAt, updatedAt }`.
A run records its status, the input it was given and one `{ type, ok, status?, detail? }` per action.

## Example

```bash
# Create a webhook flow
FLOW=$(curl -s $API/projects/$PROJECT_ID/flows -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"gh-push","trigger":{"type":"webhook"},"actions":[{"type":"log","message":"push received"}]}')
FLOW_ID=$(echo $FLOW | jq -r .id)
SECRET=$(echo $FLOW | jq -r .webhookSecret)

# Fire from an external system
RAW_BODY='{"ref":"refs/heads/main"}'
SIG="sha256=$(echo -n "$RAW_BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
curl -s -X POST $API/webhooks/flows/$FLOW_ID \
  -H "x-basefyio-signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$RAW_BODY"

# Rotate the secret
curl -s -X POST $API/projects/$PROJECT_ID/flows/$FLOW_ID/rotate-webhook-secret \
  -H "apikey: $SERVICE_KEY"
```

## Errors

| Status | When |
|---|---|
| 400 | `name is required`; `trigger.type must be one of manual, webhook, schedule`; `at least one action is required`; `action.type must be one of log, http.request`; `http.request action requires a url`; `Flow is disabled`; `Flow is not a webhook-triggered flow` |
| 401 | Missing or invalid `x-basefyio-signature` |
| 403 | anon key; not a member of the project's team |
| 404 | `Flow not found` |

Source: `apps/platform-api/src/modules/flows/flows.controller.ts`, `flow-webhook.controller.ts`,
`flows.service.ts`, `flow.types.ts`, `flow-url-guard.ts`, `flow-execute.processor.ts`;
Prisma models `Flow`, `FlowRun`.
