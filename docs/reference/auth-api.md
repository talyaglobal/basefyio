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
| POST | `/api/rest/v1/auth/signin/anonymous` | anon | a session without an account (off unless the project allows it) |
| POST | `/api/rest/v1/auth/anonymous/upgrade` | anon + user | turn the anonymous user into an e-mail/password account |
| POST | `/api/rest/v1/auth/verify-email` | anon | confirm the code from the verification mail |
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
| GET | `/api/rest/v1/auth/signin/:provider` | anon | the URL to send the browser to for OAuth sign-in |
| GET | `/api/rest/v1/auth/callback/:projectId/:provider` | public | where the provider returns; redirects to your app with tokens in the URL fragment |

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
project's `tokenExpirySeconds` setting.

## Sign-up and sign-in

`POST signup` body: `{ email, password, firstName?, lastName? }`.
Project settings that apply (defaults in brackets, changed under Authentication → Settings or
`PUT /api/projects/:projectId/auth/config`): `allowSignup` [true] — otherwise 403
`Self-signup is disabled for this project`; `minPasswordLength` [6] — otherwise 400;
`requireEmailVerify` [true] — the response still carries tokens, with `emailVerified: false`,
and a code valid for 24 hours is mailed. 409 `Email already registered`.

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

`POST verify-email` `{ otp }` → `{ message: "Email verified successfully" }`.
`POST forgot-password` `{ email }` and `POST magic-link` `{ email }` always answer
`{ message: "If an account exists, …" }`; `POST reset-password` `{ otp, newPassword }`;
`POST magic-link/verify` `{ otp }` → `{ message, userId, email, emailVerified: true }` (the
link flow confirms the address and then the app signs the user in).
`GET me` → `{ id, email, emailVerified, username, firstName, lastName, isAnonymous }`.

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
   browser to `url`. `redirect_to` must be one of the project's registered redirect URLs.
2. The provider returns to `GET /api/rest/v1/auth/callback/:projectId/:provider`, which
   redirects to your `redirect_to` with the tokens in the **fragment**:
   `#access_token=…&refresh_token=…&expires_in=…&token_type=Bearer&provider=google`.
   The SDK's `bf.auth.handleProviderCallback()` reads and clears that fragment.

## Invitations

`POST invite` `{ email }` needs the **service key** (403 `Invite requires service_role key`
otherwise): it creates the user, mails an invitation and answers
`{ message: "Invitation sent to …" }`. 409 `User already exists in this project`.

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
| 400 | `Invalid or expired verification code` / `reset code` / `magic link` / `confirmation code`; `Password must be at least N characters`; `No enrollment is in progress. Call /mfa/enroll first.`; `That code does not match the authenticator…`; `This session is not anonymous…`; `Unsupported provider` |
| 401 | `Invalid email or password`; `Invalid or expired access token`; `Invalid or expired refresh token`; `Invalid code` (`code: invalid_code`); an expired MFA challenge |
| 403 | `Self-signup is disabled for this project`; `Invite requires service_role key`; `This route acts on the signed-in user…`; anonymous sign-in disabled for the project |
| 409 | `Email already registered`; `Email already in use`; `User already exists in this project`; `An authenticator is already enrolled for this account.` |
| 429 | anonymous sign-in rate limit |

Source: `apps/platform-api/src/modules/projects/project-sdk-auth.controller.ts`,
`project-sdk-auth.service.ts`, `project-mfa.service.ts`, `project-anonymous-auth.service.ts`,
`project-oauth-callback.controller.ts`, `project-auth-config.service.ts`;
SDK: `packages/sdk/src/modules/auth.ts`.
