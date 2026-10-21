# Billing API (`/api/billing`)

Plans, the team's subscription, usage against plan limits and invoices. These routes serve the
dashboard's Billing pages; everything here is scoped to a **team** (`teamId`), because plans
and subscriptions belong to teams, not projects. Payments go through Stripe when the operator
has configured it (`STRIPE_SECRET_KEY`); a self-hosted install without Stripe still has plans
and usage, but checkout, portal and payment-method routes fail.

## Authentication

A dashboard session (Keycloak JWT). `GET /api/billing/plans` is public. Management routes
under `/api/billing/management/*` and the Stripe webhook are operator-only and not part of the
customer contract.

## Routes

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/billing/plans` | public | the plan catalogue with limits and prices |
| GET | `/api/billing/subscription` | session | `?teamId=` — the team's current plan and subscription state |
| GET | `/api/billing/usage` | session | `?teamId=` — projects, database size, storage, API requests against the plan's limits |
| GET | `/api/billing/project-costs` | session | `?teamId=` — the cost report per project |
| GET | `/api/billing/invoices` | session | `?teamId=` — invoice list |
| GET | `/api/billing/invoices/:invoiceId/pdf` | session | `?teamId=&type=` — the invoice PDF |
| GET | `/api/billing/account` | session | `?teamId=` — billing contact and tax details |
| POST | `/api/billing/account` | session | update them (`teamId` plus the address fields) |
| GET | `/api/billing/payment-method` | session | `?teamId=` — the card on file |
| POST | `/api/billing/setup-intent` | session | `{ teamId }` — begin adding a card |
| POST | `/api/billing/attach-payment-method` | session | `{ teamId, paymentMethodId }` |
| POST | `/api/billing/checkout` | session | `{ teamId, planName, successUrl, cancelUrl }` — a checkout session for a paid plan |
| POST | `/api/billing/portal` | session | `{ teamId, returnUrl }` — the customer portal |
| POST | `/api/billing/change-plan` | session | `{ teamId, planName }` |
| POST | `/api/billing/preview-plan-change` | session | `{ teamId, planName }` — the proration before changing |
| POST | `/api/billing/cancel` | session | `{ teamId }` |
| POST | `/api/billing/resume` | session | `{ teamId }` |
| POST | `/api/billing/retry-payment` | session | `{ teamId, paymentMethodId? }` |
| POST | `/api/billing/student-verification/request` | session | `{ email, teamId? }` — mail a code to a student address |
| POST | `/api/billing/student-verification/confirm` | session | `{ email, code, teamId? }` |

`teamId` defaults to the caller's active team when omitted on the `GET` routes.

## Example

```bash
curl -s https://api.basefyio.com/api/billing/plans
curl -s "https://api.basefyio.com/api/billing/usage?teamId=$TEAM_ID" -H "Authorization: Bearer $SESSION_JWT"
```

## Errors

| Status | When |
|---|---|
| 401 | no session |
| 403 | the caller is not a member of `teamId` |
| 400 | unknown `planName`, a payment the processor refused (the message is the processor's) |
| 500 | Stripe is not configured on this installation (`STRIPE_SECRET_KEY` unset); the payment routes need it |

Source: `apps/platform-api/src/modules/billing/billing.controller.ts`, `billing.service.ts`,
`usage.service.ts`, `project-costs.service.ts`.
