# Authentication API (`/api/rest/v1/auth`)

End-user authentication for one project. Every project has its own identity realm, so a user
of project A does not exist in project B. These routes are what the JavaScript SDK's
`bf.auth.*` and the Python client's `client.auth.*` call.

## Authentication

Every route takes the project's **anon key** in the `apikey` header (the service key also
works, from a server). Routes marked *anon + user* additionally need the signed-in user's
access token as `Authorization: Bearer <token>`; without it they answer 403
`This route acts on the signed-in user…`. Two routes are opened by a browser from an e-mail
link and therefore accept the anon key as `?apikey=`.

## Routes

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/rest/v1/auth/signup` | anon | create an account; mails a verification code when the project requires it |
| POST | `/api/rest/v1/auth/signin` | anon | e-mail + password sign-in; may return an MFA challenge instead of tokens |
| POST | `/api/rest/v1/auth/mfa/challenge` | anon | complete a sign-in challenge with an authenticator or recovery code |
| GET | `/api/rest/v1/auth/mfa` | anon + user | the user's second-factor status |
| POST | `/api/rest/v1/auth/mfa/enroll` | anon + user (or a challenge) | start enrolling an authenticator app |
| POST | `/api/rest/v1/auth/mfa/verify-enrollment` | anon + user (or a challenge) | confirm the first code; returns recovery codes |
| POST | `/api/rest/v1/auth/mfa/disable` | anon + user | turn the factor off (needs a code); the service key may reset a user by id |
| POST | `/api/rest/v1/auth/mfa/recovery-codes` | anon + user | replace the recovery codes |
| POST | `/api/rest/v1/auth/signout` | anon (+ user for `others`/`global`) | end a session on the server: `{ refreshToken }` ends that session; `{ scope: "others" }` every other session, `{ scope: "global" }` all of them (204) |
| POST | `/api/rest/v1/auth/signin/anonymous` | anon | a session without an account (off unless the project allows it) |
| POST | `/api/rest/v1/auth/anonymous/upgrade` | anon + user | turn the anonymous user into an e-mail/password account |
| POST | `/api/rest/v1/auth/verify-email` | anon | confirm the code from the verification mail |
| POST | `/api/rest/v1/auth/verify-email/resend` | anon | mail a new verification code; same answer whether or not the address has an account |
| GET | `/api/rest/v1/auth/verify-email-callback` | anon (`?apikey=`) | the "Verify e-mail" button target; answers with an HTML page |
| POST | `/api/rest/v1/auth/forgot-password` | anon | mail a reset code |
| POST | `/api/rest/v1/auth/reset-password` | anon | set a new password with the code |
| POST | `/api/rest/v1/auth/magic-link` | anon | mail a one-time sign-in link |
| POST | `/api/rest/v1/auth/magic-link/verify` | anon | redeem the code from the link |
| GET | `/api/rest/v1/auth/magic-link-callback` | anon (`?apikey=`) | the link target; same result as `magic-link/verify` |
| POST | `/api/rest/v1/auth/change-email` | anon + user | start changing the address; mails a code to the new one |
| POST | `/api/rest/v1/auth/change-email/verify` | anon | confirm the code |
| GET | `/api/rest/v1/auth/change-email-callback` | anon (`?apikey=`) | the mailed link target |
| POST | `/api/rest/v1/auth/reauth` | anon + user | mail a re-authentication code for a sensitive action |
| POST | `/api/rest/v1/auth/reauth/verify` | anon | confirm it |
| POST | `/api/rest/v1/auth/invite` | service | create an invited user and mail them |
| POST | `/api/rest/v1/auth/refresh` | anon | exchange a refresh token for new tokens |
| GET | `/api/rest/v1/auth/me` | anon + user | the profile behind the access token |
| GET | `/api/rest/v1/auth/signin/:provider` | anon | the URL to send the browser to for OAuth sign-in (`redirect_to`, `prompt`, `state`) |
| GET | `/api/rest/v1/auth/callback/:projectId/:provider` | public | where the provider returns; redirects to your app with tokens (or an error code) in the URL fragment |
| POST | `/api/rest/v1/auth/logout-url` | anon | a URL that ends the browser's sign-in session and returns to your app, without a confirmation page when `idToken` is sent |
| GET | `/api/rest/v1/auth/logout-callback/:projectId` | public | where the sign-out returns; redirects to your `redirectTo` |

## Tokens

Every route that signs a user in returns the same shape:

```json
{
  "accessToken": "eyJ…", "refreshToken": "eyJ…", "expiresIn": 1800, "tokenType": "Bearer",
  "userId": "3f2b…", "emailVerified": true,
  "mfaEnrollmentRequired": false
}
```

The access token is a JWT signed by the project's realm; the API verifies it against the
realm's JWKS on every request. Send it as `Authorization: Bearer <accessToken>` together with
the anon key — that is what turns a request into the `authenticated` role for row-level
security, with the claims readable in SQL through `auth.uid()`, `auth.email()` and
`auth.jwt()`. Refresh with `POST refresh` `{ "refreshToken": "…" }` →
`{ accessToken, refreshToken, expiresIn }`. The lifetime (`expiresIn`, default 1800 s) is the
project's `tokenExpirySeconds` setting, written to the realm when the setting is saved; a
realm created before that was wired keeps 1800 s until `POST /api/projects/:projectId/auth/repair`
is run once. The token also carries `role`, `aal`, `app_metadata` and `user_metadata` — see
[supabase-auth-v1.md](./supabase-auth-v1.md), the same identity system in GoTrue's shapes for
`@supabase/supabase-js`.

## Sign-up and sign-in

`POST signup` body: `{ email, password, firstName?, lastName? }`.
Project settings that apply (defaults in brackets, changed under Authentication → Settings or
`PUT /api/projects/:projectId/auth/config`): `allowSignup` [true] — otherwise 403
`Self-signup is disabled for this project`; `minPasswordLength` [6] — otherwise 400;
`requireEmailVerify` [true] — a code valid for 24 hours is mailed and the response says
`verificationRequired: true`. Usually it still carries tokens, with `emailVerified: false`.
When the project's realm holds sign-in until the address is confirmed, it carries **no
tokens**: `{ userId, emailVerified: false, verificationRequired: true }` — call `verify-email`,
then `signin`. 409 `Email already registered`.

`POST verify-email/resend` `{ email }` mails a new code to an address that signed up and is not
confirmed yet. It always answers `{ message: "If the address is waiting for verification, a new
code has been sent" }`, so it does not reveal whether the address has an account; 429
(`code: "too_many_attempts"`) after three requests for one address, or twenty from one client
IP, in an hour. Earlier codes stay valid until they expire.

`POST signin` body: `{ email, password, totp? }`. Wrong credentials: 401
`Invalid email or password`. A user imported from Supabase signs in with their existing
password; the first sign-in verifies it against the imported hash. When that password is right
but breaks the project's password rules, the answer is 401 with
`"code": "password_reset_required"`; send the user through `forgot-password`. When the account has an authenticator enrolled and `totp` was
not supplied, the response is a **challenge** instead of tokens:

```json
{ "mfaRequired": true, "challengeId": "…", "methods": ["totp", "recovery"], "expiresIn": 300, "enrollmentRequired": false }
```

Finish it with `POST mfa/challenge` `{ challengeId, code }` or `{ challengeId, recoveryCode }`,
which returns the token shape above. A wrong code is 401 with `"code": "invalid_code"`; an
expired or unknown challenge is 401. When the project enforces enrollment
(`mfaEnforceEnrollment`) and the user has no factor yet, the challenge comes back with
`enrollmentRequired: true` and `methods: ["totp"]`: call `mfa/enroll` and
`mfa/verify-enrollment` with that `challengeId` in the body — the password has already been
checked — and the verification response carries the tokens.

`POST verify-email` `{ otp, email? }` → `{ message: "Email verified successfully" }`.
`POST forgot-password` `{ email }` and `POST magic-link` `{ email }` always answer
`{ message: "If an account exists, …" }`; `POST reset-password` `{ otp, newPassword, email? }`;
`POST magic-link/verify` `{ otp, email? }` → `{ message, userId, email, emailVerified: true }` (the
link flow confirms the address and then the app signs the user in).
`GET me` → `{ id, email, emailVerified, username, firstName, lastName, isAnonymous, provider, providers }`.
`providers` lists the social providers linked to the account (`["github"]`); `provider` is the
first of them, else `password` (`anonymous` for an anonymous user).

## Second factor (authenticator apps)

| Call | Body | Response |
|---|---|---|
| `GET mfa` | — | `{ enrolled, enrollmentRequired, recoveryCodesLeft, verifiedAt }` |
| `POST mfa/enroll` | `{ challengeId? }` | `{ secret, otpauthUrl, issuer, account, algorithm, digits, period }` — show `otpauthUrl` as a QR code; 409 if a factor is already enrolled |
| `POST mfa/verify-enrollment` | `{ code, challengeId? }` | `{ enabled: true, recoveryCodes: [...] }` — the codes are shown once; plus tokens when a challenge was used |
| `POST mfa/disable` | `{ code }` or `{ recoveryCode }`; with the service key `{ userId }` | `{ enabled: false }` |
| `POST mfa/recovery-codes` | `{ code }` | `{ recoveryCodes: [...] }` |

The secret is stored by the platform, encrypted at rest with `DB_CRED_ENC_KEY`; it never
goes to the identity provider. Administrators can require enrollment per user
(`POST /api/projects/:projectId/auth/users/:userId/require-mfa`) and enforce it at sign-in
for the whole project (`mfaEnforceEnrollment` in the auth config).

### One-time codes

Send `email` with the code (basefyio-js 2.6.0 does when you pass it). The code is then accepted
only for the address it was mailed to, and five wrong codes for one address answer `429`
(`code: "too_many_attempts"`) until a new code is requested. A request with the code alone still
works for older clients, but twenty wrong codes in an hour close that path for the project
(`429`); the path with the address stays open.

## Anonymous users

`POST signin/anonymous` (anon key only) creates a user named `anon_<random>` and returns the
token shape with `emailVerified: false` and `isAnonymous: true`. It is refused with 403 unless
the project's auth config has `allowAnonymous: true`, and it is rate-limited per client IP and
per project per day (429 when exceeded). The tokens carry the claim `is_anonymous`, so a
policy can tell these sessions apart:

```sql
coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
```

`POST anonymous/upgrade` `{ email, password, firstName?, lastName? }`, sent with the anonymous
user's access token, turns the same user id into a normal account and returns fresh tokens
with `isAnonymous: false`. 400 `This session is not anonymous…` for a regular user, 409
`Email already registered`.

## OAuth providers

Configure a provider under Authentication → Providers (or
`PUT /api/projects/:projectId/auth/providers/:provider`; `google` and `github` are supported).
Then:

1. `GET signin/:provider?redirect_to=<url in your app>` → `{ url, provider }`. Send the
   browser to `url`. `redirect_to` must be one of the project's registered redirect URLs; its
   query string is kept. Optional:
   - `prompt` — `login` (sign in again), `select_account` (account chooser), `consent`, or
     `none` (no page at all; `error=login_required` when there is no session). Anything else
     is 400. Without it, Google shows the account chooser and asks to sign in again, and
     GitHub asks to sign in again.
   - `state` — your own value (1–512 characters of `A-Z a-z 0-9 - . _ ~`, otherwise 400),
     returned unchanged.
2. The provider returns to `GET /api/rest/v1/auth/callback/:projectId/:provider`, which
   redirects to your `redirect_to` with the tokens in the **fragment**:
   `#access_token=…&refresh_token=…&expires_in=…&token_type=Bearer&provider=google&id_token=…&state=…`.
   The SDK's `bf.auth.handleProviderCallback()` reads and clears that fragment.
3. When the sign-in does not produce a session, the browser still goes back to `redirect_to`,
   with `#error=<code>&error_description=…&provider=…&state=…`. Codes: `access_denied` (the user
   cancelled), `login_required`, `interaction_required`, `consent_required` (with
   `prompt=none`), `missing_profile` (the provider shared no e-mail address),
   `temporarily_unavailable`, `oauth_failed`. Your users never see an identity-server page:
   first and last name are optional, there is no "update your profile" step, Google's
   `given_name`/`family_name` and GitHub's `name` fill them in when present.

Google and GitHub providers **trust the e-mail address** by default (Google only shares
verified addresses; GitHub's is the account's primary address), so these users get
`email_verified: true` — also when the provider is linked to an account that signed up with a
password first. Turn it off per provider under Authentication → Providers ("Trust the e-mail
address", or `trustEmail: false` in `PUT /api/projects/:projectId/auth/providers/:provider`).

### Signing out of the browser session

`POST signout` ends the session's tokens on the server. A social sign-in also leaves a
sign-in session in the browser; to end that too, ask for a sign-out URL and send the browser
there:

`POST logout-url` `{ redirectTo, idToken?, state? }` → `{ url, confirmationSkipped }`.
`redirectTo` must be a registered redirect URL (400 otherwise); it is checked again when the
browser comes back, which lands on `redirectTo#signed_out=true&state=…`. Send the `id_token`
from the callback fragment as `idToken`: with it no confirmation page is shown
(`confirmationSkipped: true`); a token from another project is 400. The SDK does both steps in
`bf.auth.signOut({ redirectTo })`.

Projects created before this behaviour (November 2026) get it when a provider is saved, or
at once with `POST /api/projects/:projectId/auth/repair`.

## Invitations

`POST invite` `{ email }` needs the **service key** (403 `Invite requires service_role key`
otherwise): it creates a password-less, unconfirmed user, mails an invitation whose link signs
them in (`GET /api/auth/v1/verify`, valid seven days; the app lands on the project's first
registered redirect URL with a session and may then set a password with `PUT /api/auth/v1/user`)
and answers `{ message: "Invitation sent to …", userId }`. 409 `User already exists in this
project`.

## Examples

```bash
API=https://api.basefyio.com/api
curl -s $API/rest/v1/auth/signup -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"correct horse battery"}'

curl -s $API/rest/v1/auth/signin -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"correct horse battery"}'

curl -s $API/rest/v1/auth/me -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS_TOKEN"
```

```ts
const res = await bf.auth.signIn({ email, password });
if (res.mfa) await bf.auth.verifyMfa(res.mfa.challengeId, codeFromApp);
const { data: user } = await bf.auth.getUser();
```

## Errors

| Status | When |
|---|---|
| 400 | `Invalid or expired verification code` / `reset code` / `magic link` / `confirmation code`; `Password must be at least N characters`; `No enrollment is in progress. Call /mfa/enroll first.`; `That code does not match the authenticator…`; `This session is not anonymous…`; `Unsupported provider`; `prompt must be one of…`; `state must be…`; `redirectTo is not a registered redirect URL…`; `idToken was not issued by this project` |
| 401 | `Invalid email or password`; `Invalid or expired access token`; `Invalid or expired refresh token`; `Invalid code` (`code: invalid_code`); an expired MFA challenge |
| 403 | `Self-signup is disabled for this project`; `Invite requires service_role key`; `This route acts on the signed-in user…`; anonymous sign-in disabled for the project |
| 409 | `Email already registered`; `Email already in use`; `User already exists in this project`; `An authenticator is already enrolled for this account.` |
| 429 | anonymous sign-in rate limit; `verify-email/resend` limit (`code: too_many_attempts`) |

## E-mail providers

A project's verification, reset, magic-link and invite mails go out through the provider chosen in
project settings > Auth > Email: the platform default, custom SMTP, Resend, SendGrid, Amazon SES,
**tsmartsend**, or none (your app sends them). With tsmartsend the platform calls tsmartsend's HTTP
API (`POST /emails`) with the project's own `ts_…` key, which is stored encrypted and never returned
(the settings API shows it masked). The sender address must be on a domain verified in your tsmartsend
project; the settings refuse a tsmartsend provider without a sender address.

Source: `apps/platform-api/src/modules/projects/project-sdk-auth.controller.ts`,
`project-sdk-auth.service.ts`, `project-mfa.service.ts`, `project-anonymous-auth.service.ts`,
`project-oauth-callback.controller.ts`, `project-auth-config.service.ts`;
SDK: `packages/sdk/src/modules/auth.ts`.
