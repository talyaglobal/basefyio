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
| GET | `/api/projects/:projectId/auth/users` | service | list users — `?search=` (email, name, username), `?first=` and `?max=` (1–200) page through the realm; without `max` the first 100 are returned. Each user carries `mfaEnrollmentRequired` |
| GET | `/api/projects/:projectId/auth/users/count` | service | `{ count }` of users matching `?search=` (all users without it) |
| GET | `/api/projects/:projectId/auth/users/:userId` | service | one user with `providers`, `sessions`, `lastSignIn`, `sessionCount`, `requiredActions` and `mfa: { enrollmentRequired, enrolled }` |
| POST | `/api/projects/:projectId/auth/users` | service | create — `{ email, password, firstName?, lastName? }`; the email needs a domain with a top-level part and the password must meet the project's policy. Names left out stay empty |
| PATCH | `/api/projects/:projectId/auth/users/:userId` | service | `{ firstName?, lastName?, email?, enabled?, phoneNumber?, phoneVerified? }` — `phoneNumber` in E.164 (`+15550100100`; spaces, dashes and brackets are dropped), `""` clears it |
| POST | `/api/projects/:projectId/auth/users/:userId/reset-password` | service | `{ newPassword }` — must meet the project's policy |
| DELETE | `/api/projects/:projectId/auth/users/:userId` | service | delete the user |
| GET | `/api/projects/:projectId/auth/users/:userId/sessions` | service | the user's sessions |
| DELETE | `/api/projects/:projectId/auth/users/:userId/sessions/:sessionId` | service | revoke one session |
| POST | `/api/projects/:projectId/auth/users/:userId/logout` | service | revoke all of the user's sessions |
| POST | `/api/projects/:projectId/auth/users/:userId/send-recovery` | service | mail a password-reset |
| POST | `/api/projects/:projectId/auth/users/:userId/send-verification` | service | mail an e-mail verification |
| GET | `/api/projects/:projectId/auth/sessions` | service | every active session in the realm |
| DELETE | `/api/projects/:projectId/auth/sessions/:sessionId` | service | revoke a session |
| POST | `/api/projects/:projectId/auth/users/:userId/require-mfa` | service | `{ enabled?: true }` — require the user to enroll an authenticator at next sign-in; `{ enabled: false }` withdraws the request |
| GET | `/api/projects/:projectId/auth/mfa` | service | users with a confirmed second factor, from both sources (below) |
| DELETE | `/api/projects/:projectId/auth/users/:userId/credentials/:credentialId` | service | remove a credential (for example a lost authenticator) |
| DELETE | `/api/projects/:projectId/auth/users/:userId/mfa` | service | reset an authenticator the user enrolled through the SDK → `{ enabled: false }` |
| POST | `/api/projects/:projectId/auth/anonymous/purge` | service | `{ olderThanDays?, dryRun? }` — delete old anonymous users → `{ matched, deleted, olderThanDays, dryRun }` |
| GET | `/api/projects/:projectId/auth/policies` | service | brute-force protection, password policy and access-token lifetime (below) |
| PUT | `/api/projects/:projectId/auth/policies` | service | `{ bruteForceProtected?, permanentLockout?, failureFactor?, waitIncrementSeconds?, maxFailureWaitSeconds?, accessTokenLifespanSeconds?, password?: { minLength?, requireUppercase?, requireLowercase?, requireDigits?, requireSpecial?, historyCount?, expiryDays? } }` |
| GET | `/api/projects/:projectId/auth/config` | service | sign-up and e-mail settings |
| PUT | `/api/projects/:projectId/auth/config` | service | update them (fields below) |
| POST | `/api/projects/:projectId/auth/config/email/test` | service | `{ to?, settings? }` — connect to the e-mail provider and send a test message; `settings` may hold unsaved provider fields → `{ ok, provider, to, error? }` |
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

## Policies

`GET policies` returns `{ bruteForceProtected, permanentLockout, failureFactor, waitIncrementSeconds,
maxFailureWaitSeconds, passwordPolicy, accessTokenLifespanSeconds, password: { minLength, … } }`.
`password.minLength` is the length actually enforced: the stricter of the realm policy and the
config's `minPasswordLength`, which the SDK sign-up checks. Saving a policy writes both, so the two
never disagree.

Out-of-range values are refused with a 400 that names the field — nothing is clamped:

| Field | Range |
|---|---|
| `password.minLength` | 6–128 |
| `password.historyCount` | 0–24 |
| `password.expiryDays` | 0–3650 (0 = never) |
| `failureFactor` | 1–100 failed sign-ins before the lockout |
| `waitIncrementSeconds`, `maxFailureWaitSeconds` | 1–86400, and the maximum at least the increment |
| `accessTokenLifespanSeconds` | 300–86400 |

Policy parts the dashboard does not edit (`notUsername`, `maxLength`, …) are kept when the policy
is saved. New projects start with brute-force protection on (10 failures, a lockout growing from
1 to 15 minutes); existing projects keep their setting.

## Auth config

`GET config` / `PUT config` fields and defaults:

| Field | Default | Meaning |
|---|---|---|
| `allowSignup` | `true` | `POST /rest/v1/auth/signup` is open; otherwise 403 |
| `requireEmailVerify` | `true` | mail a verification code at sign-up |
| `minPasswordLength` | `6` | 6–128; a change is applied to the realm policy too |
| `tokenExpirySeconds` | `1800` | access-token lifetime, 300–86400; a change is applied to the realm |
| `allowAnonymous` | `false` | enables `POST /rest/v1/auth/signin/anonymous` |
| `mfaEnforceEnrollment` | `false` | every user must enroll an authenticator at sign-in |
| `emailProvider` | `null` | `smtp`, `resend`, `sendgrid`, `ses`, or `null` for the platform mailer |
| `smtpHost`, `smtpPort`, `smtpUser`, `smtpPass`, `senderEmail`, `senderName` | `null` | your own SMTP server (`emailProvider: "smtp"`) |
| `resendApiKey`, `sendgridApiKey`, `sesAccessKey`, `sesSecretKey`, `sesRegion` | `null` | the API-key providers |
| `verifyEmailSubject/Body`, `resetPasswordSubject/Body`, `welcomeSubject/Body`, `inviteUserSubject/Body`, `magicLinkSubject/Body`, `changeEmailSubject/Body`, `reauthSubject/Body` | platform templates | per-project mail templates; `{{project_name}}`, `{{otp}}` and the flow's link are substituted |

The response never includes `smtpPass` or an API key (a saved one reads `••••••••`).

A provider must be complete to be saved: `smtp` needs host, port (1–65535), username, password
and `senderEmail`; the API-key providers need their key(s) and `senderEmail`. An empty secret
keeps the saved one. Setting `emailProvider: null` returns to the platform mailer and clears the
SMTP fields. Unknown fields are refused with a 400.

`POST config/email/test` tries the settings before anyone depends on them: it logs in to the
provider and sends a short message. Through the platform mailer the test can only go to the
signed-in operator's own address. A failed test answers 200 with `ok: false` and the reason
(wrong password, unreachable host, refused sender).

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
| 400 | `Unsupported provider: …`; validation (invalid email or phone, a password below the policy, out-of-range policy values, an incomplete e-mail provider, unknown config fields) |
| 403 | anon key; caller not a member of the project's team |
| 404 | project not found; `User not found` (on `GET users/:userId`) |
| 502/503 | the identity provider did not answer (the error names the Keycloak operation) |

Source: `apps/platform-api/src/modules/projects/project-auth.controller.ts`,
`project-auth-config.service.ts`, `apps/platform-api/src/modules/auth/keycloak-admin.service.ts`.
