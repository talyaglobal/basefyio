# Spec: GoTrue-compatible auth facade (`/api/auth/v1/*`) over per-project Keycloak (2026-10-28)

Goal: `@supabase/supabase-js` + `@supabase/ssr` work UNCHANGED against a basefyio project with
`supabaseUrl = https://api.basefyio.com/api` (and, for OAuth, `https://api.basefyio.com/api/p/<projectId>`).
Paths relative to `apps/platform-api/src/`.

## 0. Facts
- Global prefix `api` (`main.ts:79-81`); `@Controller('auth/v1')` → `/api/auth/v1/*`. No collision: platform `AuthController` (`modules/auth/auth.controller.ts:27`) has only `oauth/:provider`; `PublicApiController` `:table` is one segment.
- CORS (`main.ts:64-72`) allows `apikey`, `x-client-info`, `x-supabase-api-version`; `exposedHeaders` (73) lacks `Link`. Add `accept-profile`, `content-profile`, `range`, `range-unit`, `x-retry-count` to allowedHeaders and `Link`, `Preference-Applied`, `Location` to exposedHeaders (REST compat needs them; this file owns main.ts edits).
- Global filter `{statusCode, message, code?, timestamp}` (`all-exceptions.filter.ts:37-42`). gotrue-js reads `msg|message`, `error_code`, and `code` only when `X-Supabase-Api-Version: 2024-01-01`.
- One-time codes are 6-digit, in Redis, keyed per project (`project-sdk-auth.service.ts`: verify_email 328, reset_password 369, magic_link 405, change_email 447, reauth 478, invite_user 505; `generateOtp` 992-994); redemptions get-then-del (not atomic) — `RedisService.getdel` exists (`modules/redis/redis.service.ts:123`).
- Keycloak 24 in prod without `KC_FEATURES` (`docker-compose.prod.yml:116-133`); token exchange unavailable (`project-anonymous-auth.service.ts:29-31`). Service client secret generated at `keycloak-admin.service.ts:624` and discarded.
- Guard: service key as Bearer+apikey → `role:'service'`, Bearer ignored (`api-key.guard.ts:80, 96, 105, 127-132`). Bearer JWT verified RS256 + issuer only (`322-392`; no aud/azp/typ). Claims = raw Keycloak payload (sub, email, email_verified, preferred_username, given_name, family_name, sid, azp, realm_access, scope, exp, iat, iss, typ, is_anonymous). No role/app_metadata/user_metadata/aal today. Expired JWT with anon key → 401 before controller (122).

## 1. Placement
- New files under `modules/projects/`: `supabase-auth-compat.controller.ts`, `supabase-auth-compat.service.ts`, `supabase-auth-compat.filter.ts`, `gotrue-shapes.ts`, plus `supabase-auth-open.controller.ts` (unguarded `/authorize`).
- `@Controller('auth/v1') @UseGuards(ApiKeyGuard) @UseFilters(GoTrueExceptionFilter)`; register in `projects.module.ts:61-68` beside `ProjectSdkAuthController`; same providers (ProjectSdkAuthService, ProjectMfaService, ImportedPasswordService, ProjectAuthConfigService, RedisService, KeycloakAdminService).
- Root rewrite in `main.ts` BEFORE setGlobalPrefix: `if (/^\/(auth|rest|storage|realtime)\/v1\//.test(req.url)) req.url = '/api' + req.url`. Do not add to `exclude`.
- Project identity on open routes: `/api/p/<projectId>/<rest>` → rewrite to `/api/<rest>` and set `req.headers['x-bf-project'] = <projectId>` (also `x-project-id` for the usage middleware at `app.module.ts:170`). App uses `supabaseUrl = https://api.basefyio.com/api/p/<projectId>`. `/authorize` resolves the project from `x-bf-project` when `apikey` is missing (open controller built like `project-oauth-callback.controller.ts:40-72`). Our own `/verify` links carry `&apikey=<anon>` (guard accepts anon key in query, `api-key.guard.ts:56-58`; refuses service key there `83-87`). Never infer the project from redirect_to/Referer.

## 2. Bearer verification, service calls
- Extract `verifyProjectJwt`, `getJwksClient`, `expectedIssuer` (`api-key.guard.ts:322-392`, cache `jwksByRealm` 37) into injectable `ProjectJwtVerifier`; guard and facade share it. When `payload.role === 'service'` the facade re-reads `Authorization` itself (admin.signOut, server-side /user, /logout send service apikey + user JWT).
- Scopes: admin routes `@ServiceKeyOnly()`; `/user`, `/factors*`, `/logout` `@AuthenticatedKeyOnly()` + service fallback. Guard 401s map to `bad_jwt` in the filter.
- Harden verifier (risk 3): check `typ === 'Bearer'` and an `azp` allowlist (`${realm}-anon`, `${realm}-anon-aal2`).

## 3. Error shape — `supabase-auth-compat.filter.ts`
`@Catch()`: set `X-Supabase-Api-Version: 2024-01-01`; body `{code, error_code: code, msg, message: msg}` (+ `weak_password:{reasons}` where relevant). Mapping:
| source | gotrue |
|---|---|
| Unauthorized 'Invalid email or password' (`sdk-auth:851`) | 400 invalid_credentials "Invalid login credentials" |
| totp_required (840-844) | 400 mfa_verification_failed |
| Conflict 'Email already registered' (99) | 422 user_already_exists |
| admin duplicate | 422 email_exists |
| password length BadRequest (102-104) | 422 weak_password |
| Forbidden self-signup disabled (94) | 422 signup_disabled |
| invalid refresh (873) | 400 refresh_token_not_found "Invalid Refresh Token: Refresh Token Not Found" |
| Redis code missing | 403 otp_expired "Email link is invalid or has expired" |
| guard Missing/Invalid apikey | 401 no_api_key |
| guard bad JWT (122) | 401 bad_jwt |
| 5xx | keep 502/503 (gotrue-js retries) |

## 4. Shapes — `gotrue-shapes.ts`
- `toSession({accessToken, refreshToken, expiresIn}, user)` → `{access_token, token_type:'bearer', expires_in, expires_at: jwt.exp, refresh_token, user}` (export/copy `decodeJwtPayload` from `sdk-auth:309-317`).
- `buildUser(rep)` from full Keycloak representation (`client.users.findOne`; today's `getRealmUserById` 1023-1039 drops attributes): `{id, aud:'authenticated', role:'authenticated', email, email_confirmed_at, confirmed_at, phone: attr.phoneNumber?.[0] ?? '', last_sign_in_at, app_metadata:{provider, providers, ...JSON.parse(attr.app_metadata?.[0] ?? '{}')}, user_metadata: JSON.parse(attr.user_metadata?.[0] ?? '{}'), identities:[email + federated via listUserFederatedIdentities 750-754], factors, created_at, updated_at, is_anonymous: isAnonymousUser(u) 1329-1332}`. Best-effort `last_sign_in_at` attribute write on each grant.

## 5. Keycloak changes (`keycloak-admin.service.ts`)
- Mappers next to `AUTH_TIME_MAPPER` (55-67), style of `ANONYMOUS_CLAIM_MAPPER` (1310-1324): `attrJson('app_metadata')`, `attrJson('user_metadata')` (oidc-usermodel-attribute-mapper, jsonType JSON, access+id+userinfo), `hardcoded('role','authenticated')`, `hardcoded('aal','aal1')` on `${realm}-anon` (`aal2` + `amr` JSON on `${realm}-anon-aal2`), audience mapper `authenticated`, `phone` from `phoneNumber`.
- Add to `createClients` protocolMappers (612-622) for new realms; `ensureRealmClientGoTrueMappers(realm, clientId)` (copy of `ensureRealmClientAnonymousClaimMapper` 1335-1351 with own cache) called in `authenticateInRealm` beside `ensureRealmClientAuthTimeMapper` (`sdk-auth:710`, best-effort try/catch like 1142-1146), in `POST /auth/repair` before the `if (healthy) return` (`project-auth.controller.ts:701-703`, after createClients 713) and in the missing-realm repair (`projects.service.ts:2386-2394`).
- Attributes: make `ensureUnmanagedAttributes` (1190-1206) public; add `setRealmUserMetadata(realm, userId, {app_metadata?, user_metadata?})` (read-modify-write like `updateRealmUser` 1256-1263, values `[JSON.stringify(...)]`); `createProjectUser` (978-1014) gets optional `attributes` and calls ensureUnmanagedAttributes first (as `createAnonymousUser` 1362). Default `app_metadata={provider:'email',providers:['email']}`. After OAuth sign-in merge provider alias then refresh once.
- Token lifetime: hardcoded 1800 (527); `tokenExpirySeconds` stored (`schema.prisma:451`, default `project-auth-config.service.ts:22`, returned 90) but unused; `docs/reference/auth-api.md:64-65` wrong. Add `setRealmAccessTokenLifespan(realm, s)` (`realms.update`, pattern `updateRealmPolicies` 930-946); call from `ProjectAuthController.updateConfig` (592-600) and repair. KolayStartup needs 3600–604800.
- Refresh rotation: `refreshInRealm` (857-875) returns a new refresh token; leave `revokeRefreshToken` off (concurrent refresh across tabs). Default `token_type` bearer. Add a `clientId` param to `sdkAuth.refresh` (638-642).

## 6. Session minting without a password (prerequisite for verify/otp/invite/aal2) — `KeycloakAdminService.mintSessionForUser(realm, userId, clientId)`
- Option A (no Keycloak restart, works on 24 and 26): `POST /admin/realms/{r}/users/{id}/impersonation` with the master admin token (`getAdminAccessToken` 282-296), capture `Set-Cookie` (`KEYCLOAK_IDENTITY`, `KEYCLOAK_SESSION`), then `GET /realms/{r}/protocol/openid-connect/auth?client_id=${r}-anon&response_type=code&scope=openid&prompt=none&redirect_uri=<registered>` with those cookies and `maxRedirects:0`, read `code` from `Location`, exchange it like `handleOAuthCallback` (`sdk-auth:604-622`). Register `redirect_uri` via `ensureAnonClientRedirectUri` (579-604) under the `.../callback/${projectId}/*` wildcard (544-547), e.g. `/callback/<pid>/_mint`. Downside: impersonation audit noise.
- Option B (later, ops): `KC_FEATURES=token-exchange,admin-fine-grained-authz` + per-realm permissions + client secret (`getClientSecret`); token-exchange grant with `requested_subject`.
- Implement A now behind a method; never set temporary passwords.

## 7. Endpoints
- `POST /token?grant_type=password` (@AnonKeyAllowed): reuse `sdkAuth.signin` (137-191: imported-hash adoption 154-163, self-heal 750-829, MFA parking). If `requireEmailVerify && !emailVerified` → revoke (289-303) + 400 `email_not_confirmed`. If `mfaRequired` → §7.15. Else `toSession(tokens, buildUser)`.
- `POST /token?grant_type=refresh_token`: decode `azp` to pick client; `refreshInRealm`; user from new token's `sub`.
- `POST /token?grant_type=pkce {auth_code, code_verifier}`: `getdel('gotrue_flow:<pid>:<auth_code>')`, check `base64url(sha256(verifier)) === codeChallenge` (or plain); release stored tokens or mint (§6). Errors 400 `flow_state_not_found` / `bad_code_verifier`.
- `GET /user`: validate via userinfo `getUserFromToken` (651-674, make public) → 401 once logged out; then `buildUser(sub)`.
- `PUT /user {password?, email?, data?}`: password → `resetRealmUserPassword` (1099-1107) after minPasswordLength (380); email → `requestChangeEmail` (436-457) but with a GoTrue `email_change` token-hash link; data → merge user_metadata; return user (+`new_email`).
- `POST /logout?scope=global|local|others` → 204: use `sid` claim: local `revokeUserSession` (732-740); global `logoutAllUserSessions` (743-747); others `listUserSessions` (717) minus sid.
- `POST /signup {email,password,data?,code_challenge?,code_challenge_method?}` + `?redirect_to`: don't wrap `sdkAuth.signup` (85-127 mints tokens when unverified); rebuild: allowSignup (93), duplicate (97-100), length (102), `createProjectUser(realm, data, !requireEmailVerify)` with attributes (app_metadata default, user_metadata=data; map first_name/last_name/full_name). If verification required: issue `signup` token-hash link, return bare user with `confirmation_sent_at`. Else `authenticateInRealm` (697) → session.
- `POST /recover {email, code_challenge?}`: like `forgotPassword` (359-375, skips anonymous 363) but `recovery` token-hash link; return `{}`.
- `POST /otp {email, create_user=true, data?, code_challenge?}`: like `sendMagicLink` (396-415); create password-less user when allowed; issue `magiclink` link + 6-digit `email_otp`; `{}`.
- `GET /verify?token=<hash>&type&redirect_to` (anon via `?apikey=`): `getdel('gotrue_tok:<pid>:<sha256(token)>')`, check type; side effects `setEmailVerified` (1069) / `updateRealmUserEmail` (1287) / welcome mail (350-353); mint session (§6); with codeChallenge → store flow + 303 `redirect_to?code=…`; else 303 `redirect_to#access_token=…&refresh_token=…&expires_in=…&expires_at=…&token_type=bearer&type=<type>`. Validate redirect_to with `resolveOAuthRedirect` (`oauth-redirect.util.ts:48-71`) against `redirectUrls` (518-523), fallback first registered URL. Error → 303 `redirect_to#error=access_denied&error_code=otp_expired&error_description=…`.
- `POST /verify {type, token_hash}` or `{type, email, token}` (app's `/auth/confirm` uses verifyOtp): same lookup; email+token via `gotrue_eotp:<pid>:<type>:<email>` with attempt counter (pattern `project-mfa.service.ts:401-414`); return session. Aliases: `email` ≡ signup/magiclink, `invite`, `recovery`, `email_change`.
- `POST /resend {type, email}` → `{}`.
- `GET /authorize` (open controller): map `linkedin_oidc→linkedin`, `azure→microsoft`; reuse `getOAuthRedirectUrl` (525-576) but 302, state `{redirectTo, gotrue:true, codeChallenge, method}` (560-563), unregistered redirect_to → site URL. Callback: extend `ProjectOAuthCallbackController.oauthCallback` (44-71): when `state.gotrue` merge provider into app_metadata + refresh; with codeChallenge store `gotrue_flow:<pid>:<random>`={tokens, codeChallenge} 300 s and redirect `?code=`; else fragment with `expires_at`, `token_type=bearer`. `handleOAuthCallback` (578-635) exchanges the code.
- Support: `GET /.well-known/jwks.json` (proxy realm certs, sig keys only, cache 10 min — `auth.getClaims()`), `GET /settings` (`{external:{google:…}, disable_signup, mailer_autoconfirm}` from `authConfig.getOrCreate` 38-48), `GET /health`.
- Admin (@ServiceKeyOnly): `GET /admin/users?page&per_page` (new `listRealmUsersPage(realm, first, max)` with `briefRepresentation:false` + `users.count`; body `{users, aud:'authenticated'}`; headers `X-Total-Count` + `Link` rel next/last — gotrue-js builds nextPage/lastPage/total from headers); `POST /admin/users` (duplicate → 422 email_exists; `createProjectUser` + attributes, honour `email_confirm`); `GET/PUT/DELETE /admin/users/:id` (PUT: email via `updateRealmUser` 1233-1285 but honour email_confirm instead of forcing verified 1253; password `resetRealmUserPassword`; metadata merge; `ban_duration` → enabled:false + `banned_until` attr, 'none' → enabled; phone → phoneNumber); DELETE → `deleteUser` (1016-1021) + `mfa.forgetUser` (`project-mfa.service.ts:228-232`).
- `POST /admin/generate_link {type, email, password?, data?, redirect_to}`: create user for signup/invite; mint token-hash entry WITHOUT mail; return user at top level + `properties:{action_link:'${apiBase}/auth/v1/verify?token=…&type=…&redirect_to=…&apikey=<anon>', email_otp, hashed_token, redirect_to, verification_type}` (`getPublicApiBase` 78-82, make public).
- `POST /invite` (admin.inviteUserByEmail): replace `inviteUser` (498-514; links to non-existent `/rest/v1/auth/invite-callback`): create password-less unverified user, mail `invite` token-hash link.

## 7.15 MFA
- GoTrue: aal1 session after password; `getAuthenticatorAssuranceLevel` decodes `aal`/`amr`; `listFactors` reads `user.factors`; `POST /factors/:id/challenge` → `POST /factors/:id/verify` returns a NEW aal2 session.
- Design: second public client `${realm}-anon-aal2` (same mappers, `aal=aal2`, `amr=[{"method":"totp"}]`); for enrolled users run two grants while the password is in hand (aal1 tokens returned; aal2 tokens parked via `mfa.createChallenge(..., 'verify')`, `gotrue_mfa_pending:<pid>:<sub>` → challengeId). `POST /factors {factor_type:'totp'}` → `mfa.beginEnrollment` (236-265 via `sdkAuth.beginMfaEnrollment` 227-237) → `{id, type:'totp', friendly_name, totp:{qr_code (SVG data URI; add `qrcode` dep), secret, uri}}`. `POST /factors/:id/challenge` → `{id, type, expires_at}`. `POST /factors/:id/verify {challenge_id, code}` → verified factor: `mfa.verifyChallenge` (388-429) releases aal2 tokens; unverified: `mfa.confirmEnrollment` (272-309) then mint aal2 (§6). `DELETE /factors/:id` → `mfa.disable` (438-462) only when aal2 else 403 `insufficient_aal`. `GET /user` factors `[{id, factor_type:'totp', friendly_name, status, created_at, updated_at}]`. `mfaEnforceEnrollment` (182-189) → return aal1 session.

## 8. Token-hash store (facade service)
`issueToken(project, {type, userId, email, redirectTo, codeChallenge?, method?, newEmail?, ttl})`: raw = 32 random bytes hex; otp = 6 digits; `redis.set('gotrue_tok:<pid>:<sha256(raw)>', entry, ttl)` (3600 recovery/magiclink, 86400 signup, 7d invite) and `gotrue_eotp:<pid>:<type>:<email>` → `{otp, tokenKey}`; return `{hashed_token: raw, email_otp, action_link}`. Redeem with `getdel`; delete sibling. Mail via a public wrapper over `sendEmail` (887-926). Templates: `applyVars` (988-990) only literal keys; add `{{ .ConfirmationURL }}`, `{{ .TokenHash }}`, `{{ .Token }}`, `{{ .SiteURL }}`, `{{ .RedirectTo }}`, `{{ .Email }}` aliases.

## 9. Import: carry metadata into Keycloak
`ImportedRealmUser` (22-31) and `importRealmUsers` (1507-1523) carry no attributes; `SupabaseUser` (`supabase-import.service.ts:170-180`) lacks app_metadata; reps at 3811-3824 drop both. Fix: add `app_metadata`, attributes `{app_metadata:[json], user_metadata:[json]}`, call `ensureUnmanagedAttributes` before `partialImport` (1512). Re-sync: patch attributes for `action==='SKIPPED'` users. (KolayStartup policies read `app_metadata.organization_id`.)

## 10. RLS consistency
`request.jwt.claims` = raw claims (`public-api.service.ts:504-519`) → `auth.jwt()->'app_metadata'->>'organization_id'` works once mappers exist; `request.jwt.claim.role` already `authenticated`. Optional `request.jwt.claim.aal`/`session_id` (sid) in `jwt-claim-settings.ts`.

## 11. Tests
Unit: filter mapping, toSession/buildUser. E2E with stubbed Keycloak (`test/keycloak-admin-client.stub.js`, `project-sdk-auth.mfa.spec.ts:63-72`) driving real `@supabase/supabase-js`: signInWithPassword, refreshSession, getUser, updateUser, signOut, verifyOtp({token_hash,type}), exchangeCodeForSession, admin.listUsers (headers), admin.generateLink, getClaims (JWKS). Extend `test/keycloak-compat.test.mjs` for mappers on KC 24/26.

## Risks
1 minting (§6) prerequisite; 2 project identity on open routes; 3 guard accepts any realm RS256 token (add typ/azp checks); 4 six-digit codes keyed per project, brute-forceable — per-email + attempt limits + 256-bit link hashes; 5 get-then-del races → getdel; 6 attribute length/JSON validity (always JSON.stringify; unmanagedAttributePolicy); 7 claims lag until refresh; 8 `aud` becomes array; 9 larger cookies (chunking); 10 doubled sessions for MFA (revoke aal1 after step-up); 11 behaviour differs from `/rest/v1/auth` (keep on facade only); 12 admin listing cost (cap 100); 13 timed ban needs sweep; 14 rewrite must set x-project-id for usage middleware; 15 global throttler 429s bypass controller filter; 16 doc drift (`auth-api.md:64-65`, `149-151`).
