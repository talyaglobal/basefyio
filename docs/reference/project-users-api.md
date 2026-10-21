# Project users API (`/api/projects/:projectId/auth`)

Administration of a project's **end users** — the people who sign up to your application —
as opposed to [auth-api.md](./auth-api.md), which is what those users call themselves. These
routes act on the project's identity realm.

## Authentication

Service key (`apikey`) from your server, or a dashboard session. The anon key is refused.

## Routes

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/auth` | service | realm summary |
| GET | `/api/projects/:projectId/auth/users` | service | list users |
| GET | `/api/projects/:projectId/auth/users/:userId` | service | one user with `providers`, `sessions`, `lastSignIn`, `sessionCount` |
| POST | `/api/projects/:projectId/auth/users` | service | create — `{ email, password, firstName?, lastName? }` |
| PATCH | `/api/projects/:projectId/auth/users/:userId` | service | `{ firstName?, lastName?, email?, enabled?, phoneNumber?, phoneVerified? }` |
| POST | `/api/projects/:projectId/auth/users/:userId/reset-password` | service | `{ newPassword }` |
| DELETE | `/api/projects/:projectId/auth/users/:userId` | service | delete the user |
| GET | `/api/projects/:projectId/auth/users/:userId/sessions` | service | the user's sessions |
| DELETE | `/api/projects/:projectId/auth/users/:userId/sessions/:sessionId` | service | revoke one session |
| POST | `/api/projects/:projectId/auth/users/:userId/logout` | service | revoke all of the user's sessions |
| POST | `/api/projects/:projectId/auth/users/:userId/send-recovery` | service | mail a password-reset |
| POST | `/api/projects/:projectId/auth/users/:userId/send-verification` | service | mail an e-mail verification |
| GET | `/api/projects/:projectId/auth/sessions` | service | every active session in the realm |
| DELETE | `/api/projects/:projectId/auth/sessions/:sessionId` | service | revoke a session |
| POST | `/api/projects/:projectId/auth/users/:userId/require-mfa` | service | `{ enabled?: true }` — require the user to enroll an authenticator at next sign-in |
| GET | `/api/projects/:projectId/auth/mfa` | service | users with a confirmed second factor, from both sources (below) |
| DELETE | `/api/projects/:projectId/auth/users/:userId/credentials/:credentialId` | service | remove a credential (for example a lost authenticator) |
| DELETE | `/api/projects/:projectId/auth/users/:userId/mfa` | service | reset an authenticator the user enrolled through the SDK → `{ enabled: false }` |
| POST | `/api/projects/:projectId/auth/anonymous/purge` | service | `{ olderThanDays?, dryRun? }` — delete old anonymous users → `{ matched, deleted, olderThanDays, dryRun }` |
| GET | `/api/projects/:projectId/auth/policies` | service | password policy |
| PUT | `/api/projects/:projectId/auth/policies` | service | `{ minLength?, requireUppercase?, requireLowercase?, requireDigits?, requireSpecial?, historyCount?, expiryDays? }` |
| GET | `/api/projects/:projectId/auth/config` | service | sign-up and e-mail settings |
| PUT | `/api/projects/:projectId/auth/config` | service | update them (fields below) |
| GET | `/api/projects/:projectId/auth/providers` | service | OAuth providers and their state |
| PUT | `/api/projects/:projectId/auth/providers/:provider` | service | `{ clientId, clientSecret?, enabled }` for `google` or `github` |
| POST | `/api/projects/:projectId/auth/repair` | service | recreate the realm's clients, flows and mappers the platform expects |

## Second factors and anonymous users

A user can hold a second factor in two places: an authenticator registered on the identity
provider's hosted login, or one enrolled through the SDK (`bf.auth.enrollMfa()`, see
[auth-api.md](./auth-api.md)). `GET mfa` lists both, one entry per user — `{ id, email,
firstName, lastName, factors: [{ id, type, userLabel, createdDate, source }] }` with `source`
`keycloak` or `basefyio`. Remove a `keycloak` factor with `DELETE users/:userId/credentials/:credentialId`
and a `basefyio` factor with `DELETE users/:userId/mfa`; the latter needs no code from the user.

`POST anonymous/purge` deletes anonymous users (created by `POST /rest/v1/auth/signin/anonymous`)
whose account was created more than `olderThanDays` ago (default 30, minimum 1). One call
examines one page of up to 500 anonymous accounts; repeat it until it reports `matched: 0`. With
`dryRun: true` it only reports `matched` and deletes nothing.

## Auth config

`GET config` / `PUT config` fields and defaults:

| Field | Default | Meaning |
|---|---|---|
| `allowSignup` | `true` | `POST /rest/v1/auth/signup` is open; otherwise 403 |
| `requireEmailVerify` | `true` | mail a verification code at sign-up |
| `minPasswordLength` | `6` | |
| `tokenExpirySeconds` | `1800` | access-token lifetime |
| `allowAnonymous` | `false` | enables `POST /rest/v1/auth/signin/anonymous` |
| `mfaEnforceEnrollment` | `false` | every user must enroll an authenticator at sign-in |
| `smtpHost`, `smtpPort`, `smtpUser`, `smtpPass`, `senderEmail`, `senderName` | `null` | send the project's mails through your own SMTP instead of the platform mailer |
| `verifyEmailSubject/Body`, `resetPasswordSubject/Body`, `welcomeSubject/Body`, `inviteUserSubject/Body`, `magicLinkSubject/Body`, `changeEmailSubject/Body`, `reauthSubject/Body` | platform templates | per-project mail templates; `{{project_name}}`, `{{otp}}` and the flow's link are substituted |

The response never includes `smtpPass`.

## Providers

`PUT providers/google` with `{ "clientId": "…", "clientSecret": "…", "enabled": true }`
registers the identity provider in the realm with the callback
`https://api.<your-domain>/api/rest/v1/auth/callback/:projectId/google` — that is the
redirect URI to allow at the provider. `enabled: false` removes it. 400 `Unsupported provider`
for anything but `google` and `github`.

## Example

```bash
# every user, from your server
curl -s $API/projects/$PROJECT_ID/auth/users -H "apikey: $SERVICE_KEY"

# force a password reset mail
curl -s -X POST $API/projects/$PROJECT_ID/auth/users/$USER_ID/send-recovery -H "apikey: $SERVICE_KEY"

# require an authenticator for one user
curl -s -X POST $API/projects/$PROJECT_ID/auth/users/$USER_ID/require-mfa -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" -d '{"enabled":true}'
```

## Errors

| Status | When |
|---|---|
| 400 | `User not found` (on `GET users/:userId`); `Unsupported provider: …`; validation |
| 403 | anon key; caller not a member of the project's team |
| 404 | project not found |
| 502/503 | the identity provider did not answer (the error names the Keycloak operation) |

Source: `apps/platform-api/src/modules/projects/project-auth.controller.ts`,
`project-auth-config.service.ts`, `apps/platform-api/src/modules/auth/keycloak-admin.service.ts`.
