# Billing API (`/api/billing`)

Plans, the team's subscription, usage against plan limits and invoices. These routes serve the
dashboard's Billing pages; everything here is scoped to a **team** (`teamId`), because plans
and subscriptions belong to teams, not projects. Payments go through Stripe when the operator
has configured it (`STRIPE_SECRET_KEY`); a self-hosted install without Stripe still has plans
and usage, but checkout, portal and payment-method routes fail.

## Authentication

A dashboard session (Keycloak JWT). `GET /api/billing/plans` and `GET /api/billing/rates` are public. Management routes
under `/api/billing/management/*` and the Stripe webhook are operator-only and not part of the
customer contract.

## Routes

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/billing/plans` | public | the plan catalogue with limits and prices |
| GET | `/api/billing/rates` | public | the standard usage rates: compute tiers per hour, storage per GB-month, egress per GB, API requests per million |
| GET | `/api/billing/subscription` | session | `?teamId=` — the team's current plan and subscription state |
| GET | `/api/billing/usage` | session | `?teamId=` — projects, database size, storage, API requests against the plan's limits |
| GET | `/api/billing/project-costs` | session | `?teamId=` — the cost report per project |
| GET | `/api/billing/invoices` | session | `?teamId=` — invoice list |
| GET | `/api/billing/invoices/:invoiceId/pdf` | session | `?teamId=&type=` — the invoice PDF |
| GET | `/api/billing/account` | session | `?teamId=` — billing contact and tax details |
| POST | `/api/billing/account` | session | update them (`teamId` plus the address fields) |
| GET | `/api/billing/payment-method` | session | `?teamId=` — the default card |
| GET | `/api/billing/payment-methods` | session | `?teamId=` — every saved card (`id`, `brand`, `last4`, `expMonth`, `expYear`, `isDefault`) plus `cardRequired`, `lastCardRemovable`, `lastCardReason` |
| POST | `/api/billing/payment-methods/:paymentMethodId/default` | session | `{ teamId }` — make a saved card the default |
| DELETE | `/api/billing/payment-methods/:paymentMethodId` | session | `?teamId=` — remove a saved card (see Cards below) |
| POST | `/api/billing/setup-intent` | session | `{ teamId }` — begin adding a card |
| POST | `/api/billing/attach-payment-method` | session | `{ teamId, paymentMethodId, makeDefault? }` — save the card; it becomes the default unless `makeDefault` is `false` and a default exists |
| POST | `/api/billing/checkout` | session | `{ teamId, planName, successUrl, cancelUrl }` — a checkout session for a paid plan |
| POST | `/api/billing/portal` | session | `{ teamId, returnUrl }` — the customer portal |
| POST | `/api/billing/change-plan` | session | `{ teamId, planName }` |
| POST | `/api/billing/preview-plan-change` | session | `{ teamId, planName }` — the proration before changing |
| POST | `/api/billing/downgrade-preview` | session | `{ teamId }` — the three steps of a move to Free, what is owed, and what is over the Free limits |
| POST | `/api/billing/downgrade` | session | `{ teamId }` — move to Free (see Moving to Free below) |
| POST | `/api/billing/cancel` | session | `{ teamId }` — the same as `downgrade` |
| POST | `/api/billing/resume` | session | `{ teamId }` — undo a scheduled move to Free |
| POST | `/api/billing/retry-payment` | session | `{ teamId, paymentMethodId? }` |
| POST | `/api/billing/student-verification/request` | session | `{ email, teamId? }` — mail a code to a student address |
| POST | `/api/billing/student-verification/confirm` | session | `{ email, code, teamId? }` |

`teamId` defaults to the caller's active team when omitted on the `GET` routes and on
`DELETE /api/billing/payment-methods/:paymentMethodId`. Platform API tokens with `billing:read`
reach the `GET` routes; every change needs a dashboard session.

## Cards

A team can save several cards; one is the default and is charged for plan changes and
renewals.

- **Paid plans** (price above zero) always keep at least one card: removing the last card is
  refused with `400` and `code: "last_card_required"`.
- **Legacy and grandfathered accounts** (plan `legacy`, or plan features `grandfathered: true`)
  may remove every card.
- **Free plan**: the last card may be removed, except while the team owes money (an unpaid
  invoice, a failed renewal or a failed upgrade still being retried).
- Removing the default card makes another saved card the default first.
- A card saved on another customer answers `404`. Two card removals for one team at once:
  the second answers `409`.
- Choosing a paid plan (`change-plan`, `preview-plan-change`, `checkout`) needs a saved
  default card: otherwise `400` with `code: "card_required"`.

## Moving to Free

`POST /api/billing/downgrade` runs three steps in this order and stops at the first that fails;
nothing is ever deleted for you.

1. **Pay what is owed** with the default card: unpaid invoices, and a failed renewal (charged
   in full). A failed upgrade that is still being retried is dropped, not charged. A refused
   payment answers `400` with `code: "payment_failed"` and changes nothing.
2. **Fit the Free plan limits**: projects, members, file storage and database size above the
   Free limits answer `400` with `code: "over_free_limits"` and a `blockers` list (current,
   limit, what to reduce). This month's API requests, bandwidth and active users are only
   warnings in the preview.
3. **Switch**: at the end of a paid period that is still running (no refund for the remaining
   days), otherwise at once. `resume` undoes a scheduled move.

`POST /api/billing/downgrade-preview` returns the same checks without charging anything:
`steps` (`pay`, `limits`, `switch` with `done`/`pending`/`blocked`), `outstanding`, `limits`
(`blockers`, `warnings`), `effectiveAt` and `canProceed`.

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
| 400 | unknown `planName`, a payment the processor refused (the message is the processor's), `card_required`, `last_card_required`, `payment_failed`, `over_free_limits` |
| 404 | a card that is not saved on this team |
| 409 | another card change for the team is in progress |
| 500 | Stripe is not configured on this installation (`STRIPE_SECRET_KEY` unset); the payment routes need it |

Source: `apps/platform-api/src/modules/billing/billing.controller.ts`, `billing.service.ts`,
`usage.service.ts`, `project-costs.service.ts`.
