# Supabase-compatible auth (`/api/auth/v1`)

GoTrue — the API behind Supabase Auth — served over a project's own identity realm, so
`@supabase/supabase-js` and `@supabase/ssr` work against a basefyio project unchanged:

```ts
import { createClient } from '@supabase/supabase-js';
const supabase = createClient('https://api.basefyio.com/api', ANON_KEY);
```

For social sign-in the client also works with `https://api.basefyio.com/api/p/<projectId>` as
the base URL (the project named in the path; see *OAuth* below). The paths a Supabase client
derives (`/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1`) are also accepted at the host
root and mapped under `/api`.

This is the same identity system as [`/api/rest/v1/auth`](./auth-api.md): the same users,
passwords, sessions and settings, in GoTrue's shapes. An app may use either; a token from one
is valid on the other.

## Authentication

Every route takes the project's **anon key** in the `apikey` header — supabase-js sends it —
and, where GoTrue does, the user's access token as `Authorization: Bearer <token>`. Admin
routes need the **service key** as `apikey` (a client created with the service key); with it,
a Bearer user token is still honoured on the routes that act on a user (`admin.signOut`, a
server-side `getUser(jwt)`).

Errors answer in GoTrue's shape, with `X-Supabase-Api-Version: 2024-01-01`:
`{ code, error_code, msg, message }` (+ `weak_password: { reasons }`), e.g. 400
`invalid_credentials`, 400 `email_not_confirmed`, 422 `user_already_exists`, 422
`weak_password`, 422 `signup_disabled`, 400 `refresh_token_not_found`, 403 `otp_expired`,
401 `bad_jwt`, 401 `no_api_key`, 403 `not_admin`, 404 `user_not_found`.

## Routes

| Method | Path | Key | Purpose |
|---|---|---|---|
| POST | `/api/auth/v1/token?grant_type=password` | anon | `signInWithPassword` — e-mail + password → session |
| POST | `/api/auth/v1/token?grant_type=refresh_token` | anon | `refreshSession` — `{ refresh_token }` → new session (the refresh token rotates) |
| POST | `/api/auth/v1/token?grant_type=pkce` | anon | `exchangeCodeForSession` — `{ auth_code, code_verifier }` → session |
| POST | `/api/auth/v1/signup` | anon | `signUp` — `{ email, password, data? }`; a session, or the bare user with `confirmation_sent_at` when the project requires e-mail confirmation |
| GET | `/api/auth/v1/user` | anon + user | `getUser` — the user behind the token; 401 `bad_jwt` once signed out |
| PUT | `/api/auth/v1/user` | anon + user | `updateUser` — `{ password?, email?, data?, phone? }`; a new e-mail is confirmed through a mailed link (`new_email` until then) |
| POST | `/api/auth/v1/logout?scope=global\|local\|others` | anon + user | `signOut` — ends the realm session(s); 204 |
| POST | `/api/auth/v1/recover` | anon | `resetPasswordForEmail` — mails a recovery link and code; always `{}` |
| POST | `/api/auth/v1/otp` | anon | `signInWithOtp` — mails a magic link and code, creating a password-less user unless `create_user: false` |
| POST | `/api/auth/v1/resend` | anon | `resend` — `{ type: 'signup' \| 'email_change', email }` |
| POST | `/api/auth/v1/verify` | anon | `verifyOtp` — `{ type, token_hash }` or `{ type, email, token }` → session. `type`: `email`, `signup`, `magiclink`, `recovery`, `invite`, `email_change` |
| GET | `/api/auth/v1/verify?token=…&type=…&redirect_to=…` | anon (`?apikey=`) | the mailed link; 303 to `redirect_to` with the session in the fragment, or `?code=` for a PKCE client, or `#error=…&error_code=otp_expired` |
| GET | `/api/auth/v1/authorize?provider=…&redirect_to=…` | anon (`?apikey=`) or `/api/p/<projectId>` | `signInWithOAuth` — 302 to the identity provider |
| GET | `/api/auth/v1/settings` | anon | `{ external: { google, github, … }, disable_signup, mailer_autoconfirm }` |
| GET | `/api/auth/v1/health` | anon | liveness |
| GET | `/api/auth/v1/.well-known/jwks.json` | anon | the realm's signing keys — what `getClaims()` verifies with |
| POST | `/api/auth/v1/factors` | anon + user | `mfa.enroll` — `{ factor_type: 'totp', friendly_name? }` → `{ id, totp: { qr_code, secret, uri } }` |
| POST | `/api/auth/v1/factors/:factorId/challenge` | anon + user | `mfa.challenge` → `{ id, type, expires_at }` |
| POST | `/api/auth/v1/factors/:factorId/verify` | anon + user | `mfa.verify` — `{ challenge_id, code }` → an **aal2** session |
| DELETE | `/api/auth/v1/factors/:factorId` | anon + user (aal2) | `mfa.unenroll` |
| GET | `/api/auth/v1/admin/users?page&per_page` | service | `admin.listUsers` — `{ users, aud }` with `X-Total-Count` and `Link` (`per_page` ≤ 100) |
| POST | `/api/auth/v1/admin/users` | service | `admin.createUser` — `{ email, password?, email_confirm?, user_metadata?, app_metadata?, phone?, ban_duration? }` |
| GET | `/api/auth/v1/admin/users/:userId` | service | `admin.getUserById` |
| PUT | `/api/auth/v1/admin/users/:userId` | service | `admin.updateUserById` — same fields; metadata merges; `ban_duration: 'none'` lifts a ban |
| DELETE | `/api/auth/v1/admin/users/:userId` | service | `admin.deleteUser` |
| POST | `/api/auth/v1/admin/generate_link` | service | `admin.generateLink` — `{ type, email, password?, new_email?, data? }` → the user plus `action_link`, `email_otp`, `hashed_token`, `redirect_to`, `verification_type`; nothing is mailed |
| POST | `/api/auth/v1/invite` | service | `admin.inviteUserByEmail` — creates a password-less user and mails the invitation |

The provider returns to `GET /api/rest/v1/auth/callback/:projectId/:provider` (shared with the
platform SDK); a flow started here lands on the app's `redirect_to` with `?code=` (PKCE, the
default in supabase-js) or the session in the fragment.

## The session and the user

A session is `{ access_token, token_type: 'bearer', expires_in, expires_at, refresh_token, user }`.
The access token is the realm's RS256 JWT and carries what a Supabase app reads from it:
`sub`, `email`, `role: 'authenticated'`, `aal` (`aal1`, or `aal2` after a second factor, with
`amr`), `aud: 'authenticated'`, `app_metadata`, `user_metadata`, `phone`, `sid`. Row-level
security sees the same claims through `auth.jwt()`, so a policy such as
`auth.jwt() -> 'app_metadata' ->> 'organization_id'` works as it does on Supabase. Its
lifetime is the project's `tokenExpirySeconds` setting (default 1800 s; up to 30 days).

The user is `{ id, aud, role, email, email_confirmed_at, confirmed_at, phone, last_sign_in_at,
app_metadata: { provider, providers, … }, user_metadata, identities, factors, created_at,
updated_at, is_anonymous, banned_until? }`. `app_metadata` and `user_metadata` are stored on
the realm user as JSON attributes; `updateUser({ data })` and the admin routes merge into them.

## Links and codes

Every mailed link (`signup`, `magiclink`, `recovery`, `invite`, `email_change`) is a 256-bit
single-use token, redeemed once by `token_hash` or by the six-digit code mailed with it
(`email` + `token`, at most five wrong codes per address). Links are valid for one hour
(recovery, magic link, e-mail change), one day (sign-up) or seven days (invite). The mail
templates under Authentication → E-mails may use GoTrue's variables —
`{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .TokenHash }}`, `{{ .SiteURL }}`,
`{{ .RedirectTo }}`, `{{ .Email }}` — alongside the platform's own.

`redirect_to` is honoured when it is one of the project's registered redirect URLs
(Authentication → Providers → Redirect URLs); otherwise the first registered URL is used.

## OAuth

`signInWithOAuth({ provider })` opens `GET /api/auth/v1/authorize`. A browser arrives by
navigation and cannot send the `apikey` header, so the project is named either by `?apikey=`
(supabase-js adds it) or by the base URL `https://api.basefyio.com/api/p/<projectId>`. Provider
names follow supabase-js: `google`, `github`, `azure` (Microsoft), `apple`, `gitlab`,
`linkedin_oidc`, `facebook`, `twitter`.

## Multi-factor authentication

A user with an enrolled authenticator signs in to an **aal1** session; `mfa.challenge` +
`mfa.verify` with a code step it up to **aal2** (a second session on the realm's aal2 client).
`getAuthenticatorAssuranceLevel()` reads `aal` and `amr` from the token, and
`user.factors` lists the enrolled factor. Removing a verified factor needs an aal2 session
(403 `insufficient_aal` otherwise).

## Example

```bash
API=https://api.basefyio.com/api
curl -s "$API/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" -d '{"email":"ada@example.com","password":"correct horse battery"}'

curl -s "$API/auth/v1/admin/users?page=1&per_page=50" -H "apikey: $SERVICE_KEY" -i
```
