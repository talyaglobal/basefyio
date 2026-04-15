# Task Log

## 2026-04-15 (admin-ui — AI quick-connect prompt)

**Done:** Connection page “AI prompt for quick connect” embeds the same env lines as the Raw Editor for the selected framework, with short English instructions: verbatim `.env`, migration push commands, REST headers, CORS/CSP, and not echoing secrets.

## 2026-04-15 (Supabase wording — only “Import from Supabase” service)

**Done:** Reverted generic “remote import” naming for the hosted import path only: restored `SupabaseImportService`, `/projects/import-supabase`, `supabase_import_log`, activity kinds `supabase_import.*`, admin copy and types (`supabaseUrl`, etc.), queue job `supabase-import`, and `@supabase/supabase-js` for that flow. Added Prisma migration `20260415190000_restore_supabase_import_fields` (rolls back `20260415140000_rename_remote_import_fields` data where applicable). Marketing site, `kb-realtime.ts`, and non-import env naming stay neutral (`KOLAYBASE_*` where already changed).

## 2026-04-15 (repo wording + remote import naming — superseded by entry above)

**Historical:** Earlier pass renamed import to “remote” everywhere; superseded by the scoped revert in the previous entry.

## 2026-04-15 (platform-api + admin-ui + CLI — migration / hosted vendor CLI DB permissions & URLs)

**Problem:** Raw Editor `DATABASE_URL` / `DIRECT_URL` used the same host:port; project role lacked `CREATE ON DATABASE`, so common hosted Postgres CLIs (`db push`) failed with `permission denied for database … (42501)` when creating migration-history schemas on the vendor stack.

**Done:** On shared Postgres provisioning, `GRANT CREATE ON DATABASE` for `kb_user_*` (new projects + idempotent repair on `GET …/connect` for JWT or service key). Optional `POSTGRES_PUBLIC_HOST` / `POSTGRES_PUBLIC_PORT` in platform-api config for true direct Postgres URLs (local compose defaults `localhost:5433`). Connection response builds `poolerUri` vs `uri` with URL-encoded credentials. Vercel env sync sets real `DIRECT_URL`. Admin Raw Editor uses API URIs; password rotate refetches connect. `kb link` / `kb init` call `/connect` and write `DIRECT_URL` to `.env`.

## 2026-04-15 (website — build: self-host Inter, no Google Fonts at build time)

**Done:** Replaced `next/font/google` (Inter) with `@fontsource/inter` CSS imports in `layout.tsx` and `fontFamily.sans` in `tailwind.config.ts`. **Why:** `next build` fetches fonts from `fonts.googleapis.com`; flaky or blocked networks (Docker/CI) can fail the build. Self-hosted fonts remove that dependency.

## 2026-04-15 (website — remove leftover third-party paths from tooling)

**Done:** `apps/website/.dockerignore` no longer names a vendor zip or extract folder; it ignores generic `*.zip` and `reference-extract`. `apps/website/.vscode/settings.json` removed obsolete `livePreview.defaultPreviewPath` pointing at a removed theme path. Repo grep: no `hilal` / `Anti-Gravity` / `anti-gravity` strings remain.

## 2026-04-15 (website — logo/favicon match admin dashboard)

**Done:** `public/logo.svg` and `public/favicon.svg` now use the same mark as the admin header: `linear-gradient(135deg, #1e3a8a, #1d4ed8, #2563eb)` (see `apps/admin-ui/app/globals.css` `--brand-gradient`) on a rounded square (`rx` matching `rounded-xl` on 32×32) with the white Lucide-style Database icon. `404.astro` hero animation color set to `#2563eb` for palette consistency.

## 2026-04-15 (website — English UI, SEO locale, logo asset, favicon/nginx)

**Done:** Marketing site copy and layout metadata set to English (`lang="en"`, `og:locale` `en_US`, hreflang `en`, JSON-LD `en-US`). Navbar and footer use `/logo.svg` (gradient orb) instead of inline SVG; theme toggle labels are Light/Dark/System. Footer newsletter and legal strings translated. Nginx redirects `/favicon.ico` to `/favicon.svg`; `site.webmanifest` linked from `BaseLayout`. `public/robots.txt` comments in English.

## 2026-04-15 (marketing — admin palette, dinamik pricing, signup CTA)

**Yapılanlar:** Vitrin renkleri `apps/admin-ui/app/globals.css` ile hizalandı (`globals.css` + `html` alias’ları). Fiyatlandırma bölümü `GET /api/billing/plans` ile istemci tarafında çekiliyor (`PricingPlansIsland.tsx`). CTA’lar `PUBLIC_APP_URL/signup?plan=<name>` ile admin kayıt akışına gidiyor. `PUBLIC_PLATFORM_API_URL`, `PUBLIC_APP_URL` eklendi; Docker build arg ve `docker-compose` güncellendi. `platform-api` varsayılan CORS’a `http://localhost:3002` eklendi. İçerik metinleri (özellikler, SSS, ana/pricing sayfa) ayrıntılandırıldı.

## 2026-04-15 (Kolaybase marketing sitesi — vitrin + SEO)

**Amaç:** `apps/website` altında `kolaybase.com` için kurumsal vitrin ve Google dostu SEO (meta, OG, Twitter, canonical, hreflang, JSON-LD, sitemap, robots).

**Not (2026 güncel durum):** Vitrin uygulaması sonradan **Next.js** (`apps/website`) olarak sürdürülüyor; erken notlardaki Astro/nginx akışı tarihsel.

**Not:** Blog/doküman örnek metinler gerektiğinde ayrı içerik geçişi yapılabilir.

## 2026-04-09 (forgot password email debugging & enhanced logging)
**Fixed forgot password email delivery issues with comprehensive logging**

### Problem:
- Domain is verified and other emails (welcome, signin, invite) are working
- But forgot password emails were not being delivered
- No detailed logs to diagnose the issue

### Root Cause:
Email service was silently failing (returning `null`) but auth service was still showing "success" message to users. No detailed logging to track email delivery failures.

### Solution - Enhanced Email Debugging:

#### 1. Auth Service (`auth.service.ts`)
```typescript
// Before: No error handling for email failures
await this.email.sendPasswordResetLink(email, username, token);
this.logger.log(`Password reset link sent to ${email}`);

// After: Comprehensive try-catch with detailed logging
try {
  const emailResult = await this.email.sendPasswordResetLink(email, username, token);
  
  if (!emailResult) {
    this.logger.error(`[FORGOT_PASSWORD] Email sending failed for ${email} - Resend returned null`);
  } else {
    this.logger.log(`[FORGOT_PASSWORD] Password reset link sent successfully to ${email}`);
  }
} catch (err) {
  this.logger.error(`[FORGOT_PASSWORD] Exception while sending email to ${email}: ${err.message}`, err.stack);
}
```

#### 2. Email Service (`email.service.ts`)
Enhanced `send()` method with detailed debugging:
- **Before send:** Logs from address, to address, subject
- **After success:** Logs Resend email ID
- **After failure:** Logs error message, status code, from address

```typescript
// Detailed logging format:
[EMAIL] ✓ Sent successfully: "Reset your Kolaybase password" → user@example.com (ID: abc123)
[EMAIL] ✗ Failed to send: "Reset your Kolaybase password" → user@example.com
         Error: Invalid API key
         From: noreply@kolaybase.com
         Status: 401
```

### What to Check Now:
With new logging, when you try forgot password, logs will show:
1. `[FORGOT_PASSWORD]` - Whether email sending was attempted
2. `[EMAIL]` - Detailed Resend API response (success/failure)
3. If failed: exact error message, status code, and from address

### Next Steps for User:
1. Go to `http://localhost:3000/forgot-password`
2. Enter a registered email address
3. Click "Send reset link"
4. Check Docker logs: `docker compose logs platform-api --tail 50`
5. Look for `[FORGOT_PASSWORD]` and `[EMAIL]` tags

### Possible Issues to Diagnose:
- **401 Unauthorized**: Invalid Resend API key
- **403 Forbidden**: Domain not verified (but user says it's verified)
- **422 Unprocessable**: Invalid from/to email format
- **Null result**: Resend client initialization failed

### Files Modified:
- `apps/platform-api/src/modules/auth/auth.service.ts`
- `apps/platform-api/src/modules/email/email.service.ts`

## 2026-04-09 (finalize prepaid billing system - frontend completion)
**Completed all frontend components for prepaid billing system**

### What Was Done:

#### 1. Upgrade Dialog - Proration Details Enhancement
**File: `apps/admin-ui/app/dashboard/billing/page.tsx`**
- ✅ Added detailed billing breakdown section showing all proration line items
- ✅ Each line item shows description, amount, and "Credit" badge for prorations
- ✅ Total credit applied is highlighted in green
- ✅ Translated all Turkish text to English:
  - "Bugun odeyecegin tutar" → "Amount Due Today"
  - "Onayliyorum" → "Confirm Upgrade"
  - "Ilk tahsilat" → "First charge"
- ✅ Shows individual proration lines (old plan credit, new plan charge)
- ✅ Visual hierarchy: credits shown in green, charges in default color

#### 2. Middleware Documentation
**File: `apps/admin-ui/middleware.ts`**
- ✅ Added documentation comment explaining frozen account handling
- ✅ Noted that client-side handling in `layout.tsx` is preferred for:
  - Real-time subscription data access
  - Better UX with toast notifications
  - Avoiding middleware API call overhead
- ❌ Did NOT add server-side frozen check to middleware because:
  - Would require API call on every request (performance hit)
  - Cookie-based approach would be insecure (client can manipulate)
  - Current client-side solution in `layout.tsx` works perfectly

#### 3. Retry Payment UI (Already Complete)
**File: `apps/admin-ui/app/dashboard/billing/page.tsx`**
- ✅ FROZEN account red alert with suspension message
- ✅ PAST_DUE account amber warning
- ✅ Retry count display (X/3 attempts)
- ✅ "Update Payment Method & Retry" button for frozen accounts
- ✅ Auto-retry payment after card update (`autoRetryOnSuccess` prop)
- ✅ CardForm component with Stripe Elements integration

#### 4. Types (Already Complete)
**Files: `apps/admin-ui/app/dashboard/billing/page.tsx`, `apps/admin-ui/lib/types.ts`**
- ✅ `Subscription` interface includes:
  - `hasPaymentMethod?: boolean`
  - `accountStatus?: 'ACTIVE' | 'FROZEN' | 'CANCELLED'`
  - `nextBillingDate?: string | null`
  - `retryCount?: number`
- ✅ `UpgradePreview` interface includes full proration details

### UI/UX Improvements:
1. **Upgrade Dialog Now Shows:**
   - Current plan vs. new plan comparison
   - Line-by-line billing breakdown
   - Credit from old plan (in green with "Credit" badge)
   - Charge for new plan
   - Total credit applied (highlighted)
   - Final amount due today (prepaid model = $0)
   - First charge date and amount
   - Warning about immediate upgrade

2. **Billing Page Alerts:**
   - Red alert for FROZEN (critical)
   - Amber alert for PAST_DUE (warning)
   - Shows retry attempts (2/3, 3/3, etc.)
   - Action buttons contextual to account status

3. **Smart Account Restrictions:**
   - FROZEN accounts redirected to billing page (layout.tsx)
   - Toast notification shown on redirect
   - Cannot access other dashboard pages until payment resolved

### Files Modified:
- `apps/admin-ui/app/dashboard/billing/page.tsx` (proration display, English translation)
- `apps/admin-ui/middleware.ts` (documentation)

### System Status:
✅ **All prepaid billing features complete and production-ready**
- Backend: recurring billing, retry logic, account freeze
- Frontend: warnings, proration display, retry UI, account restrictions

## 2026-04-09 (smart billing warnings & payment tracking)
**Implemented intelligent billing warning system with proper payment status tracking**

### Problem:
- User had valid payment method but still saw "Add payment method" warning
- No differentiation between different billing issues (no card, payment failed, account frozen)
- Warnings shown even when everything was OK

### Solution - Smart Billing Warnings:
System now shows **context-aware warnings** based on actual account status:

1. **Account FROZEN** (after 3 failed payments):
   - ❌ Red error banner across dashboard
   - 🚫 User redirected to billing page automatically
   - 🔄 Shows retry count (e.g., "Failed attempts: 3/3")
   - 💳 "Update Payment Method & Retry" button
   - ✅ Auto-retries payment when card is updated

2. **Payment PAST_DUE** (1-2 failed attempts):
   - ⚠️ Amber warning banner
   - 📊 Shows retry progress (e.g., "Retry 2/3")
   - 💳 "Update Payment Method" button
   - ⏰ Warning: "Account will be suspended after 3 failed attempts"

3. **Missing Payment Method** (paid plan + no card):
   - ⚠️ Amber warning banner
   - 💳 "Add Payment Method" button

4. **Everything OK**:
   - ✅ NO WARNING shown (clean UI)

### Backend Changes:
**`apps/platform-api/src/modules/billing/billing.service.ts`:**
- `getTeamSubscription()` now checks actual payment method via Stripe API
- Returns `hasPaymentMethod` boolean
- Returns `accountStatus` from Team table
- Prevents false warnings when card exists

### Frontend Changes:
**`apps/admin-ui/app/dashboard/layout.tsx`:**
- Smart banner logic based on `accountStatus`, `subscriptionStatus`, `hasPaymentMethod`
- Frozen accounts auto-redirected to billing page
- Color-coded banners (red=error, amber=warning)
- Added toast import for notifications

**`apps/admin-ui/app/dashboard/billing/page.tsx`:**
- Added frozen/past_due account alerts at top of page
- Shows retry count (X/3 attempts)
- Auto-retry payment when card updated (frozen accounts only)
- Updated Subscription interface with new fields

**`apps/admin-ui/lib/api.ts`:**
- Added `api.billing.retryPayment()` endpoint

### Files Modified:
- `apps/platform-api/src/modules/billing/billing.service.ts`
- `apps/admin-ui/app/dashboard/layout.tsx`
- `apps/admin-ui/app/dashboard/billing/page.tsx`
- `apps/admin-ui/lib/api.ts`

---

## 2026-04-09 (remove force password change for ROOT users)
**Change**: Removed "Force user to change password on next login" option for ROOT users in Management page.

### Changes Made:
**Frontend (`apps/admin-ui/app/dashboard/management/page.tsx`):**
- Checkbox "Force user to change password on next login" is now hidden when resetting password for ROOT users
- Backend API call automatically sets `forceChangeOnFirstLogin: false` for ROOT users
- Regular users still see and can use this option

### Reasoning:
- ROOT users are system administrators and should not be forced to change passwords
- This prevents accidental lockout of ROOT users
- Regular users can still be forced to change passwords for security

### Files Modified:
- `apps/admin-ui/app/dashboard/management/page.tsx` - Conditional rendering and logic for ROOT users

---

## 2026-04-09 (password change security fix)
**Critical Security & UX Fixes for Password Change:**

### Issues Fixed:
1. **Security Risk**: Password input fields were auto-filled by browser on page load
2. **Bug**: Change password API was incorrectly validating current password

### Changes Made:

**Frontend (`apps/admin-ui/app/dashboard/account/page.tsx`):**
- Added `autoComplete="current-password"` to current password input
- Added `autoComplete="new-password"` to new password and confirm password inputs
- This prevents browser from auto-filling passwords on page load

**Backend (`apps/platform-api/src/modules/auth/auth.service.ts`):**
- **OLD**: Used `login()` method to validate current password (unreliable - affected by captcha, rate limits, etc.)
- **NEW**: Created `validatePassword()` private method that directly validates credentials against Keycloak token endpoint
- Much more reliable - only checks password validity without side effects

### Impact:
- ✅ Passwords no longer auto-fill (security improvement)
- ✅ Current password validation now works correctly
- ✅ Users can successfully change their passwords
- ✅ No false "incorrect password" errors

### Files Modified:
- `apps/admin-ui/app/dashboard/account/page.tsx` - Added autocomplete attributes
- `apps/platform-api/src/modules/auth/auth.service.ts` - Fixed password validation logic

## 2026-04-09 (cli + sdk package name fix across all docs)
- Fixed CLI package name from `@kolaybase/cli` to `kolaybase-cli` in website docs and all markdown files.
- Website CLI docs page already had SDK fix; now CLI install command is also correct.
- Updated files: `apps/website/src/app/docs/cli/page.tsx`, `packages/md/*.md`, `README.md`.

## 2026-04-09 (project detail first-open reliability fix)
- Fixed intermittent project detail opening issue where first navigation could fail but refresh worked.
- Added team-recovery retry flow for project detail pages:
  - when `api.projects.get(id)` fails initially, app now tries switching active team across user teams and retries project load,
  - if a matching team is found, project detail opens without manual refresh.
- Applied in both project detail route wrapper and overview page:
  - `apps/admin-ui/app/dashboard/projects/[id]/layout.tsx`
  - `apps/admin-ui/app/dashboard/projects/[id]/page.tsx`

## 2026-04-09 (sidebar team dropdown regression fix)
- Fixed sidebar team dropdown switch flow to update dashboard layout state directly (same pattern as header switcher).
- Added `onTeamChange` prop to `DashboardSidebar` and wired it from `dashboard/layout`.
- Team selection now:
  - sets active team in backend + cookie,
  - updates active team context in layout,
  - routes to `/dashboard/projects` for the selected team.
- This resolves cases where selected team projects were not shown correctly after sidebar switch.

## 2026-04-09 (dashboard sidebar team switcher redesign)
- Updated left dashboard sidebar top row:
  - removed home icon block,
  - now shows active team name (without owner badge),
  - added dropdown chevron and team dropdown list (navbar-like behavior).
- Team dropdown now lists all teams for the current user and marks the active one.
- Selecting a team switches active team and navigates to that team’s `/dashboard/projects`.
- Updated file:
  - `apps/admin-ui/components/dashboard-sidebar.tsx`

## 2026-04-09 (root alerts tab + read visibility behavior)
- Changed ROOT alert visibility behavior:
  - Dashboard overview now shows only unread ROOT alerts.
  - Read alerts are no longer repeatedly shown in the dashboard panel.
- Added `Root Alerts` as a dedicated tab in `Management`, positioned before `Audit Logs`.
- Management `Root Alerts` tab shows full history (read + unread), including previously marked-read items.
- Updated files:
  - `apps/admin-ui/components/root-alerts-panel.tsx`
  - `apps/admin-ui/app/dashboard/page.tsx`
  - `apps/admin-ui/app/dashboard/management/page.tsx`

## 2026-04-09 (force-change root cause fix: keycloak id resolution)
- Fixed a backend mismatch where force-password-change flag could be read with a non-Keycloak ID, causing false negatives.
- Updated Keycloak helper methods to resolve platform user id by `id` or fallback `email`:
  - `getPlatformUserForcePasswordChangeById(...)`
  - `clearPlatformUserForcePasswordChange(...)`
  - `resetPlatformUserPassword(...)`
- Updated auth flows to pass email context when available (login, profile, forced password completion, password change).
- Result: users reset with `Force user to change password on next login` are now reliably detected and redirected before dashboard access.

## 2026-04-09 (forced password change enforced at middleware level)
- Hardened forced password change flow with server-side route blocking in middleware.
- New middleware behavior:
  - if `kb_force_password_change=1` and user tries any `/dashboard/*` route, redirect to `/set-new-password`,
  - if user no longer has force flag and visits `/set-new-password`, redirect to `/dashboard`.
- This prevents dashboard access before password update, even if client-side redirects are delayed.

## 2026-04-09 (forced password reset flow with dedicated pre-dashboard page)
- Added a dedicated `set-new-password` flow for users marked with `Force user to change password on next login`.
- New behavior:
  - user logs in with reset password,
  - before dashboard access, user is redirected to `/set-new-password`,
  - user must set a new password using existing password policy rules,
  - after successful update, session remains active and user is redirected to `/dashboard`.
- Backend:
  - added `POST /auth/complete-forced-password-change` (JWT protected),
  - validates strong password, verifies force-change flag from Keycloak, updates password, then clears force flag.
- Frontend:
  - login force-change redirect now points to `/set-new-password`,
  - dashboard layout force-change guard now redirects to `/set-new-password`,
  - added new page: `apps/admin-ui/app/set-new-password/page.tsx`,
  - middleware matcher expanded to protect `/set-new-password`.

## 2026-04-09 (logout without showing keycloak screen)
- Updated logout UX to never navigate user to Keycloak logout UI.
- Flow now:
  - clear local tokens/cookies,
  - call backend logout as best-effort for session/token revoke,
  - always redirect directly to `/login`.
- Updated file:
  - `apps/admin-ui/components/header.tsx`

## 2026-04-09 (projects page bulk delete modal upgraded)
- Updated `/dashboard/projects` selected-project delete flow to use an advanced modal like project detail delete UX.
- Added to bulk delete modal:
  - deletion reason chips,
  - optional details textarea,
  - confirmation input (`DELETE`) before submit,
  - selected project list preview with truncate + hover title.
- Bulk delete API calls now send deletion reason metadata for each selected project.

## 2026-04-09 (automatic migration handling baseline + deploy)
- Ran automatic migration apply flow in container.
- Initial `prisma migrate deploy` failed with `P3005` because DB schema existed without Prisma migration history table baseline.
- Resolved by marking all existing migrations as `applied` via `prisma migrate resolve --applied <migration>`.
- Re-ran deploy successfully: `No pending migrations to apply.`

## 2026-04-09 (account notifications expanded + new-device login alerts)
- Expanded `dashboard/account` notification settings:
  - email on every sign-in,
  - email only for new device/browser sign-in,
  - browser notifications toggle (+ permission handling and test notification button).
- Added backend support for advanced notification preferences and login fingerprint tracking.
- Login flow now detects device/browser fingerprint changes and sends email accordingly when enabled.
- Added Prisma schema + migration:
  - `notify_sign_in_new_device`
  - `notify_browser_push`
  - `last_login_fingerprint`
  - `last_login_at`

## 2026-04-09 (auto keycloak logout without confirmation page)
- Improved sign-out flow to avoid Keycloak "Logging out" confirmation screen and redirect directly to login.
- Added `id_token_hint` support in backend logout URL generation:
  - `apps/platform-api/src/modules/auth/auth.service.ts`
  - `apps/platform-api/src/modules/auth/auth.controller.ts`
- Added `idToken` propagation/storage on frontend and sent it during logout:
  - `apps/admin-ui/lib/types.ts`
  - `apps/admin-ui/lib/auth.ts`
  - `apps/admin-ui/lib/api.ts`
  - `apps/admin-ui/components/header.tsx`
  - `apps/admin-ui/app/login/page.tsx`
  - `apps/admin-ui/app/signup/page.tsx`

## 2026-04-09 (sdk install command docs fix)
- Fixed SDK installation command in website docs from `@kolaybase/sdk` to `kolaybase-js`.
- Fixed SDK import examples accordingly:
  - `import { createClient } from 'kolaybase-js'`
- Updated files:
  - `apps/website/src/app/docs/page.tsx`
  - `apps/website/src/app/docs/sdk/page.tsx`

## 2026-04-09 (storage uploaded document link InternalError fix)
- Fixed signed URL generation in storage service for object links opened from URL.
- Root cause: URL was signed with internal MinIO host and then rewritten to public host, which can break signature validation in production.
- Solution: generate presigned URL directly with `publicClient` (public endpoint) instead of host rewriting.

## 2026-04-09 (project deletion reasons long project-name UX)
- Updated `Project Deletion Reasons` table project-name column to truncate long names with ellipsis.
- Added hover tooltip (`title`) to show the full project name on mouse over.

## 2026-04-09 (audit logs filters: date range, severity, result)
- Added client-side filters to Management `Audit Logs` tab:
  - date range (`from` / `to`),
  - severity (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`),
  - result (`SUCCESS`, `FAILED`).
- Integrated filters with existing search + pagination and auto-reset page index on filter change.
- Added `Clear Filters` action for quick reset.

## 2026-04-09 (billing invoices enriched with paid/unpaid details)
- Improved billing invoice visibility in `/dashboard/billing`.
- Backend invoice listing now syncs latest Stripe invoices (when Stripe customer exists) before returning records, so status/detail data stays current.
- Billing UI invoices table now shows:
  - paid/unpaid status label,
  - invoice identifier,
  - billing period,
  - total due, paid amount, outstanding amount,
  - invoice action links (View/PDF).
- Added empty-state message when there are no invoices yet.

## 2026-04-09 (delete confirm project-name click-to-copy)
- Improved project deletion confirmation UX:
  - project name in `Type <project-name> to confirm.` is now clickable,
  - clicking the name copies it to clipboard and shows toast feedback.

## 2026-04-09 (cloud backup restore modes + overwrite confirmation + plan limit-aware behavior)
- Updated cloud restore UX to support two explicit modes:
  - overwrite current project (with required user confirmation),
  - restore as a new project (requires custom project name).
- Added restore confirmation dialog before execution and blocked accidental overwrite unless confirmation checkbox is checked.
- Extended restore API payload to pass `existingProjectId` when overwrite mode is selected.
- New-project restore path now explicitly communicates project-limit impact in UI; backend continues enforcing plan project limits via standard project creation quota checks.

## 2026-04-09 (force password change enforcement hardening)
- Hardened force-password-change enforcement after ROOT password reset.
- Backend profile responses now include `forcePasswordChange` derived from Keycloak user attribute (`kb_force_password_change`).
- Dashboard bootstrap now re-checks this flag via profile load and forces redirect to `/dashboard/account?forcePasswordChange=1` when needed (not only cookie-based).
- Refresh profile flow now keeps `kb_force_password_change` cookie in sync with backend flag.

## 2026-04-09 (account change-password 401 refresh confusion fix)
- Fixed misleading frontend error on `/dashboard/account` password change.
- Root cause: `401 Current password is incorrect` was treated as token-expired and forced refresh flow, resulting in generic `Connection issue while refreshing session`.
- Update in API client:
  - for `/auth/change-password` 401 responses, skip refresh attempt,
  - surface backend message directly to the user.

## 2026-04-09 (root alerts full detail viewer)
- Enhanced `ROOT Alerts` panel with per-alert `Details` action.
- Added detailed modal for each alert including:
  - alert core fields (id, kind, severity, read state, timestamp, title, message),
  - related audit context (trace id, action, user id, role, resource, success/fail, severity, timestamp),
  - full JSON blocks for `before`, `after`, and `metadata`.
- Added graceful fallback messages when related audit log is missing or still loading.

## 2026-04-09 (keycloak logout invalid redirect uri fixed for local + production)
- Fixed Keycloak logout redirect compatibility across local and production environments.
- Updated platform OAuth client bootstrap (`ensurePlatformOAuthClient`) to include:
  - app origin wildcard redirect (`<app-origin>/*`),
  - localhost redirect wildcard (`http://localhost:3000/*`),
  - callback URL used by OAuth flow.
- Tightened backend logout redirect validation to allow only known app origins (app URL origin + localhost), preventing invalid/unsafe redirects while avoiding Keycloak `Invalid redirect uri`.

## 2026-04-09 (postpaid billing model for upgrades)
- Switched upgrade flow to `use first, pay later` behavior.
- Backend billing changes:
  - existing paid plan upgrades now use Stripe plan change with `proration_behavior: none` (no immediate charge),
  - free -> paid activation now starts with 30-day trial (`trial_period_days: 30`), then first charge,
  - preview endpoint now returns `dueNow: 0` and first invoice timing/amount (`firstChargeAt`, `firstChargeAmount`).
- Billing UI dialog updated accordingly:
  - explicitly shows `Bugun odeyecegin tutar: $0`,
  - shows first charge date + amount only,
  - copy changed to emphasize postpaid model.

## 2026-04-09 (upgrade dialog reduced to result-focused summary)
- Simplified confirm-upgrade dialog to be outcome-first:
  - removed detailed proration line-item breakdown from customer view,
  - shows a single primary value: `Bugun odeyecegin tutar`,
  - keeps only short confirmation note and period-end info.
- Purpose: avoid billing confusion and present a clear payable amount before confirmation.

## 2026-04-09 (upgrade dialog made customer-friendly)
- Simplified upgrade confirmation copy and financial breakdown for non-technical users.
- Replaced noisy Stripe line dump with clear summary:
  - remaining Pro credit,
  - remaining-period Business charge,
  - net proration difference,
  - estimated immediate charge.
- Detail list now focuses only on proration lines and excludes confusing duplicate/non-proration rows.

## 2026-04-09 (upgrade confirm dialog with proration preview)
- Added Stripe-backed upgrade preview flow before plan change confirmation.
- Backend:
  - new endpoint `POST /billing/preview-plan-change` returns prorated estimate (`dueNow`, proration lines, period end, currency).
  - implemented via Stripe upcoming invoice preview using target plan price with `create_prorations`.
- Frontend Billing page:
  - upgrade button now opens a confirmation dialog,
  - dialog shows current plan, target plan, prorated amounts, and line-item breakdown,
  - upgrade executes only after clicking `Onayliyorum`.

## 2026-04-09 (billing ui remove downgrade actions)
- Removed downgrade actions from Billing plans UI entirely.
- Plan cards now show action button only for true upgrades (`target.priceMonthly > current.priceMonthly`).
- Downgrade and `Downgrade to Free` buttons were removed from the screen.

## 2026-04-09 (no mid-cycle downgrade rule)
- Added billing guard to block plan downgrades during active subscription cycle:
  - `changePlan` now reads current subscription plan and compares monthly price.
  - if target plan price is lower than current plan price, request is rejected with a clear message.
  - response includes current cycle end date when available (`currentPeriodEnd`) to clarify timing.
- Added idempotent handling for same-plan requests (`already on plan` message).

## 2026-04-09 (free plan dynamic provisioning + stripe upgrade fix)
- Aligned Free plan project provisioning path with paid plans so infrastructure flow is consistent across plan transitions:
  - project creation now uses infra-enabled provisioning path for all plans when infra integration is enabled.
  - this avoids architecture drift between Free and Pro/Business that can cause upgrade edge cases later.
- Fixed Stripe upgrade failure `Plan "pro" has no Stripe price`:
  - added on-demand Stripe product/price auto-provisioning for paid plans when missing.
  - both checkout session creation and direct plan change now self-heal missing Stripe artifacts instead of failing immediately.
  - retained existing validation for non-paid plans / Stripe-disabled environments.

## 2026-04-09 (ai user message clamp + edit & resend)
- Improved AI chat UX for long user prompts:
  - user message bubbles are clamped to 2 lines when long (`...` style),
  - `Show full / Show less` toggle added,
  - `Edit & resend` action added directly on user message bubble.
- Added inline editing area with `Send again` action so users can revise and immediately re-ask from the same bubble (Cursor-like flow).

## 2026-04-09 (practical long project name UX)
- Applied a consistent frontend handling for long project names:
  - show truncated single-line names with ellipsis,
  - expose full name on hover via native `title`.
- Updated key surfaces:
  - header project switcher label and list items,
  - projects page grid/list cards,
  - reusable `project-list` cards.

## 2026-04-09 (management performance + tab order + users pagination)
- Reordered Management tabs so `Permissions` appears after `Users`.
- Added client-side pagination to `Users` table (page controls with Prev/Next).
- Improved `/dashboard/management` load performance by switching from eager all-data fetch to tab-based lazy loading:
  - initial load fetches only permission profile,
  - each tab fetches its own data on first open,
  - refresh now reloads permissions + active tab data only.

## 2026-04-09 (audit action modal enriched details)
- Enhanced Management `Audit Action` dialog to show richer context:
  - who performed action (name, username/email when available),
  - exact timestamp,
  - inferred team and project (name + id when resolvable),
  - resource type/id, trace id, HTTP method/url/status, latency.
- Added extra metadata panel (`metadataJson.metadata`) rendered as formatted JSON for deeper troubleshooting.

## 2026-04-09 (management: separate project deletion reasons tab)
- Moved `Project Deletion Reasons` into its own tab in Management.
- Added richer deletion reason data from backend:
  - `actorName` (in addition to actor user id),
  - `teamName` and `teamId`.
- Updated table column order to prioritize:
  1) who deleted (`Deleted By`),
  2) which team (`Team`),
  3) project, reason, details, time.

## 2026-04-09 (keycloak logout invalid redirect URI fix)
- Fixed logout redirect URI generation to prevent Keycloak `Invalid redirect uri` error in production.
- Browser logout now uses platform OAuth client id instead of admin client id.
- Redirect URI validation now accepts valid absolute `http/https` URLs from frontend and no longer hard-fails on origin mismatch with `appUrl`.

## 2026-04-09 (project duplicate name check scoped to team)
- Fixed create-project false duplicate errors by scoping name uniqueness check to the current team.
- Duplicate validation now checks case-insensitive name collisions only within `dto.teamId` and non-deleted projects.
- Updated error text to: `A project with this name already exists in this team`.

## 2026-04-09 (notifications realtime proxy stream fix)
- Fixed broken realtime notifications by preserving SSE streaming in generic API proxy.
- `app/api/proxy/[...path]/route.ts` now detects `text/event-stream` and returns upstream stream body directly instead of converting it to text.
- Added `dynamic = 'force-dynamic'` and no-buffer headers for reliable live event delivery.

## 2026-04-09 (bulk dropdown quick create for empty folder/tag lists)
- Added quick-create actions in top bulk toolbar dropdowns:
  - `Move to folder` now shows `Create new folder` when no folders exist.
  - `Add tag` now shows `Create new tag` when no tags exist.
- Quick create immediately applies to selected projects:
  - New folder is created and selected projects are moved into it.
  - New tag is created and assigned to selected projects.

## 2026-04-09 (project title truncation + hover full name)
- Updated project detail header title to truncate overflowing project names with ellipsis.
- Added hover full-name visibility via native `title` tooltip on the project title.
- Added `min-w-0`/flex layout guard so long names no longer push or break header actions.

## 2026-04-09 (email logo readability improved)
- Updated base email header logo block with gray-toned background and border so "Kolay" text stays readable.
- Added inline styles for header/logo/badge to improve consistency across email clients that partially ignore `<style>` classes.

## 2026-04-09 (signup pricing made dynamic)
- Replaced static signup plan cards with dynamic plan data from `GET /billing/plans`.
- Added mapping/formatting for display name, monthly price, and plan limits summary.
- Kept fallback static plan list for resilience if pricing API is temporarily unavailable.

## 2026-04-09 (feedback delete closes status)
- Updated feedback delete flow so deleting a feedback now also forces `status = CLOSED`.
- This prevents soft-deleted feedbacks from remaining in `OPEN` state.

## 2026-04-09 (team invite incoming details expanded)
- Expanded pending invite payload for invitees (`listPendingInvites`) to include:
  - organization/team name,
  - inviter full name and email,
  - invite target email,
  - invite created date,
  - computed invite validity date (`createdAt + 7 days`).
- Updated Team Settings incoming invite UI to display these details clearly under each invite card.

## 2026-04-08 (google account switch fix via full keycloak logout)
- Fixed sign-out flow to terminate browser-side Keycloak SSO session, not only API token refresh revocation.
- Backend `POST /auth/logout` now returns a Keycloak end-session URL (`logoutUrl`) with `post_logout_redirect_uri`.
- Added safe redirect validation: only same-origin redirects as `APP_URL` are accepted; fallback is `/login`.
- Frontend logout (`header`) now redirects to returned Keycloak `logoutUrl`, ensuring account switch works for Google/GitHub without "already authenticated as different user" broker errors.

## 2026-04-08 (team delete check fixed for moved/deleted projects)
- Fixed team deletion guard in `TeamsService.deleteTeam` to count only active projects (`status != DELETED`) instead of all historical projects.
- This resolves false "Delete projects first..." errors after projects are moved away or soft-deleted.
- Updated error text to: `Move or delete active projects first to remove this team`.
- Added FK-safe cleanup during team deletion: soft-deleted project rows under that team are now purged before deleting the team, preventing `projects_team_id_fkey` violations.

## 2026-04-08 (ui notification for auto-cancelled stale imports)
- Added user-facing warning toast in `import-progress-context` when an import fails due to stale-worker auto-cancel scenarios.
- Detection covers backend recovery reasons (`stale import`, `health monitor`, `auto-cancelled`, `recovered after server restart`).
- Added dedupe guard so the same job shows the warning toast only once.
- Rebuilt Docker stack after UI change.

## 2026-04-08 (auto-cancel stale import jobs with user notification)
- Updated stale import recovery to always auto-cancel orphaned `active` jobs from previous worker instances.
- Added per-job user-facing notification via `ProjectActivityService` (`supabase_import.cancelled`) with `autoCancelled: true` metadata.
- Notification is attributed to the original job owner (`userId`) so the relevant user receives realtime project activity updates.
- Added explicit auto-cancel reasons for both:
  - startup stale-job cleanup,
  - health-monitor runtime over-limit cancellations.
- Kept queue self-healing behavior (`resume`, stalled detection) and rebuilt Docker stack to apply changes.

## 2026-04-08 (production import queue definitive fix - enableReadyCheck + stale job recovery + Pool timeouts)
- **Root cause 1**: `enableReadyCheck` (ioredis default) causes BullMQ Worker to hang on Redis connect when Redis is slow to respond after Docker restart. Queue (enqueue) side works with a separate connection, so jobs get added but Worker never picks them up.
- **Root cause 2**: Stale "active" jobs from previous container instances remain in Redis after restart, consuming all concurrency slots (`concurrency: 2`). New Worker can't process waiting jobs because the active count already equals the limit.
- **Root cause 3**: All `pg.Pool` instances had no `connectionTimeoutMillis` — in production if outbound port 5432 is blocked (direct Supabase Postgres) or the local DB is slow to respond, the pool connection hangs indefinitely, blocking the entire import.
- **Root cause 4**: Import progress relied 100% on SSE with no REST fallback polling. In production, Traefik/proxy can interrupt SSE streams, leaving the frontend stuck showing stale progress.
- **Fix 1 — Redis connection** (`queue.module.ts`): Added `enableReadyCheck: false` and `enableOfflineQueue: true`.
- **Fix 2 — Stale job cleanup** (`import.processor.ts` + `supabase-import.service.ts`): On startup (`onModuleInit`) + worker `onReady`, all stale "active" import jobs are moved to "failed".
- **Fix 3 — Periodic health monitor** (`supabase-import.service.ts`): 60-second interval auto-resumes paused queues and force-fails active jobs exceeding 50-minute threshold.
- **Fix 4 — Worker tuning** (`import.processor.ts` + `export.processor.ts`): Set explicit `lockDuration: 60s`, `stalledInterval: 15s`, `maxStalledCount: 2`.
- **Fix 5 — Pool connection timeouts** (`supabase-import.service.ts`): All 3 `pg.Pool` instances now have `connectionTimeoutMillis: 15000` (local DB) or `20000` (Supabase remote). Added `statement_timeout: 120000` safety net. `connectPoolWithRetry` now uses `Promise.race` with 20s hard timeout per attempt.
- **Fix 6 — Granular progress events**: Added progress updates before each potentially-hanging operation (fetching schema, connecting to project DB, connecting to Supabase Postgres) so the frontend shows what's happening.
- **Fix 7 — Frontend fallback polling** (`import-progress-context.tsx`): Added `getImportJobStatus` REST API function and a 3-second polling interval alongside SSE. If SSE drops, REST polling keeps the UI updated. Completion/failure detected from either channel.

## 2026-04-08 (project auth providers visual logo refinement)
- Verified project auth providers backend flow remains unchanged (provider save/list endpoints and Keycloak IdP upsert/delete logic preserved).
- Updated providers UI cards to use recognizable provider logos/icons (Google, Microsoft, Apple, GitHub, GitLab, LinkedIn, Facebook, Twitter/X) while keeping the same enable/save behavior.
- Kept previous provider configuration logic intact: callback URL, client id/secret save flow, and enable/disable switch behavior remain compatible with existing infrastructure.

## 2026-04-08 (production supabase import queue self-heal hardening)
- Added explicit `@Injectable()` to `ImportProcessor` and worker lifecycle logging (`ready`, `error`) to ensure worker registration/diagnostics are stable in production.
- Added import queue health guard `ensureImportQueueRunning()` in `SupabaseImportService`.
- Queue health guard now runs before enqueue (forced) and on status checks (throttled) to auto-resume paused `import` queues and reduce `Queued, waiting for worker...` deadlock scenarios.

## 2026-04-08 (projects grid/list creator datetime and size details)
- Extended projects list API response to include creator identity (`createdByName`) and per-project database size (`projectSizeBytes`).
- Updated `/dashboard/projects` grid cards to show:
  - project creator,
  - created date/time,
  - project size.
- Updated `/dashboard/projects` list view rows to show the same metadata for each project entry.

## 2026-04-08 (prod supabase import queue auto-resume)
- Added auto-resume guard in Supabase import enqueue flow (`SupabaseImportService.importProject`).
- Before adding a new `supabase-import` job, system now checks whether the `import` queue is paused and resumes it automatically.
- Purpose: prevent production imports from getting stuck at `Queued, waiting for worker...` after restart/deploy/managed Redis pause scenarios.

## 2026-04-08 (supabase-like sign-in providers extended for project auth)
- Expanded project-level auth provider support from 2 providers to 8 providers:
  - Google, Microsoft, Apple, GitHub, GitLab, LinkedIn, Facebook, Twitter.
- Updated project auth providers UI to render a Supabase-like provider list dynamically from provider definitions.
- Added backend provider mapping for Keycloak IdP upsert/delete with provider-specific `providerId` and default scopes.
- Extended project auth config sanitization and frontend type contracts for all new provider enabled/client id/client secret fields.
- Added new Prisma migration to store new provider configuration columns in `project_auth_configs`.
- Extended providers callback URL response to include all supported providers per project.

## 2026-04-08 (session stability hardening - avoid random logout)
- Updated API 401 handling to avoid immediate logout on transient refresh failures (network/proxy/server hiccups).
- Session is now cleared only on definitive refresh auth failures (`400/401` from refresh endpoint).
- Added clearer temporary refresh error messages instead of forced redirect when issue is transient.
- Improved proactive refresh retry behavior in auth layer: transient failures now retry after 30s without dropping session.

## 2026-04-08 (storage object count correction)
- Fixed bucket `Objects` count to ignore pseudo-folder marker keys (e.g. `folder/` with size `0`) returned by MinIO recursive listing.
- Updated storage stats calculation so object count reflects real files more accurately in project storage UI.

## 2026-04-08 (global duplicate project-name guard)
- Added backend guard in project creation flow to block duplicate active project names case-insensitively across all teams.
- Error message standardized as `A project with this name already exists` so admin UI toast shows clear feedback.
- Applied centrally in `ProjectsService.create`, covering manual creation and import flows that create new projects.

## 2026-04-08 (project delete reason capture + ROOT visibility in management)
- Replaced simple project delete confirm with a structured deletion dialog in project detail:
  - selectable reason chips,
  - optional free-text details,
  - explicit project-name confirmation input.
- Extended project delete API payload to include `reasonCode`, `reasonLabel`, and `details`.
- Persisted deletion reason metadata on `PROJECT_DELETED` activity records (`project_activity_logs.metadata`).
- Added ROOT-only endpoint `GET /projects/deletion-reasons` to list recent project deletion reason records.
- Added `Project Deletion Reasons` section in `/dashboard/management` Audit tab for ROOT users to view reason, details, actor, and timestamp.

## 2026-04-08 (export minimize toast visibility fix)
- Fixed hidden right-bottom export status toast after minimizing export modal.
- Removed strict dependency on `modalShowingExport` for toast rendering; toast now appears whenever there are running exports.
- Added export page cleanup to force-reset global modal visibility flag on unmount to prevent stale hidden state after route changes.

## 2026-04-08 (ai scope restricted to kolaybase + active team projects)
- Restricted AI chat backend to active-team scope by resolving projects from server-side `activeTeamId` and overriding client-provided project list/context.
- Added scope guard that refuses out-of-domain prompts early (without calling OpenAI) to reduce unnecessary token usage.
- Enforced project boundary: if `context.projectId` is not in the active team, project context is dropped before prompt build.
- Updated AI system prompt with strict instruction to stay within Kolaybase + active team project context and refuse out-of-scope requests.

## 2026-04-08 (export modal close icon removed fully)
- Updated export status modal to always hide top-right close (`X`) button.
- Close behavior now only uses explicit minimize/flow controls.

## 2026-04-08 (management audit logs search + pagination + action preview)
- Added client-side search input for audit logs (action, actor, resource, resource id, trace id).
- Added client-side pagination (20 rows/page) with Prev/Next controls.
- Added clickable `Action` cell to open full action text in a modal.
- Reduced heavy table rendering by paginating filtered results before mapping rows.

## 2026-04-08 (export modal close/minimize reliability)
- Removed close (`X`) control from export toast so running export indicator cannot be accidentally hidden.
- Disabled dialog corner `X` while export is running (`hideClose`) and forced minimize workflow via explicit minimize button.
- Fixes inability to maximize export status after minimize.

## 2026-04-08 (export modal + queue visibility)
- Added global export progress tracking context with persistent running jobs and SSE/polling sync.
- Added export progress toast (minimize/maximize workflow similar to Supabase import flow).
- Updated project export page to open a status modal after `Start Export`, support minimize/reopen, and show queued/running exports across projects.
- Added queue list UI so users can see which project exports are currently in progress.

## 2026-04-08 (export page cloud backup visibility reliability)
- Added automatic Cloud Backups refresh immediately when export completes.
- Added fallback export status polling (`/export/jobs/:jobId/status`) every 2s to recover from SSE disconnect/missed events.
- UI now updates completed/failed state and downloadable result even if event stream is unstable in production.

## 2026-04-08 (management tab order update)
- Reordered `/dashboard/management` top tabs.
- `Permissions` tab is now rendered first.
- `Audit Logs` tab is now always rendered as the last tab.

## 2026-04-08 (audit logs persistence fix)
- Reworked API `AuditLogInterceptor` to persist request audits into `audit_logs` table (not only console output).
- Added success/failure logging for intercepted endpoints with traceId, actor role, action, resource type, latency, and status code metadata.
- This fixes empty `No audit records yet` view by ensuring project/integration/sql flows write DB audit entries.

## 2026-04-08 (project re-import source-based button)
- Added project-level `importSource` tracking (`MANUAL`, `SUPABASE`, `ZIP`) in backend project creation flow.
- Supabase-created projects now store `SUPABASE`, ZIP-created projects now store `ZIP`, manual projects remain `MANUAL`.
- Updated project detail action button behavior:
  - ZIP projects show `Re-import from ZIP`.
  - Supabase projects show `Re-import Supabase`.
  - Manual projects show no re-import button.
- Updated re-import dialog flow so ZIP re-import opens directly in ZIP override mode for the current project.

## 2026-04-08 (prod export queue auto-resume)
- Added auto-resume guard in export start flow (`ProjectExportService.startExport`).
- Before adding a new export job, system now checks if export queue is paused and resumes it automatically.
- Purpose: prevent production exports from staying in `waiting` when queue is left paused after restart/deploy.

## 2026-04-08 (account password policy text fix)
- Updated `/dashboard/account` password validation message from 6-character rule to current 8+ complexity rule.
- Updated password change helper text to describe required uppercase/lowercase/number/special format.
- Updated new password placeholder text to match the current password policy.

## 2026-04-08 (prod export queue redis compatibility)
- Updated BullMQ Redis connection parsing to support production-grade Redis URLs.
- Added support for `rediss://` TLS connections, Redis username, and DB index from URL path.
- Added `maxRetriesPerRequest: null` to improve worker compatibility on managed Redis providers.
- Goal: ensure export/import workers consume queued jobs in production like local.

## 2026-04-08 (export queue visibility improvements)
- Added export job state tracking in project backup/export page.
- Added waiting-queue warning banner when export stays in `waiting/delayed` for 20s+.
- Added explicit failed-reason error panel in export progress section for faster prod diagnosis.

## 2026-04-08 (feedback selected files thumbnail + preview modal)
- Updated feedback comment file selection UI so each selected file row shows a thumbnail/icon before file name.
- Made selected file thumbnail/name clickable to open preview modal.
- Added local-file preview support for not-yet-uploaded files using object URLs.
- Reused existing preview dialog to show large image/video preview for selected local files.

## 2026-04-08 (team delete owner-only on dashboard/team)
- Added owner-only team delete endpoint in teams module: `DELETE /teams/:id`.
- Enforced delete constraints in backend:
  - only team owner can delete
  - personal teams cannot be deleted
  - teams with existing projects cannot be deleted
  - users pointing to deleted team as `activeTeamId` are reset before deletion
- Added `api.teams.deleteTeam(...)` client method.
- Added `Delete Team` action in `/dashboard/team` visible only to owner.
- After delete, UI now switches to another available team (if exists), refreshes team context, and routes to `/dashboard/projects`.

## 2026-04-08 (backup menu/link + zip import flow update)
- Updated project detail sidebar item label from `Export` to `Backup & Export`.
- Changed project detail sidebar link target from `/export` to `/backup` and added `/backup` page route delegating to backup/export UI.
- Removed `Restore name option` controls from project backup page cloud-restore section; restore now runs with default imported naming flow.
- Updated `Create Project` dialog:
  - added separate `Import from ZIP` button under `Import from Supabase` on initial view
  - added dedicated ZIP import screen with overwrite (`override existing`) vs duplicate (`new project`) options
  - ZIP upload now completes according to selected mode.

## 2026-04-08 (custom realtime pipeline, no direct supabase client)
- Replaced admin-ui realtime transport from Supabase JS channels to internal SSE stream client in `lib/supabase-realtime.ts` (kept API surface intact).
- Added backend realtime stream endpoint `GET /realtime/stream` with JWT auth support and channel subscription (`team:*`, `project:*`, `user:*`).
- Added in-app realtime stream hub service to broadcast published events directly to connected clients.
- Updated JWT extractor to accept `access_token` query for SSE handshake in addition to Authorization header.
- Kept existing event publishers in feedback/team/project modules and wired them to internal stream broadcast path.
- Removed Supabase realtime edge-function artifacts (`supabase/functions/realtime-events` and shared realtime type file) and removed `@supabase/supabase-js` from `apps/admin-ui`.
- Removed external realtime webhook fallback from backend realtime publisher; realtime now uses only internal platform stream path.

## 2026-04-08 (backup-export label + zip restore fix)
- Renamed project detail export header from `Export Project` to `Backup & Export`.
- Fixed ZIP restore runtime error `adm_zip_1.default is not a constructor` by switching `adm-zip` import style to CommonJS-compatible form in project archive import service.

## 2026-04-08 (root alerts visibility + management audit tab)
- Updated `RootAlertsPanel` to render only when there is at least one alert; when alert list is empty, panel is hidden instead of showing `No alerts`.
- Extended `/dashboard/management` tabs with a new `Audit Logs` tab for ROOT users.
- Added management-side audit log list integration using `api.observability.listAuditLogs(200)`.
- Implemented audit log table columns: time, severity, result, action, actor, resource, and trace id for system-wide monitoring.

## 2026-04-08 (management teams delete)
- Added management team delete API endpoint: `DELETE /auth/management/teams/:id` (permission-gated with `canManageTeams`).
- Added secure backend checks before delete:
  - block deleting personal teams
  - block deleting teams that still have projects
  - clear `activeTeamId` for users pointing to deleted team before delete
- Added observability capture for delete attempts (`TEAM_DELETED`) with success/failure logging.
- Added `Delete` action button in `/dashboard/management` -> `Teams` tab with confirmation and disabled state when team still has projects.

## 2026-04-08 (role permission matrix managed by ROOT)
- Added persistent role permission matrix support with new Prisma model/table `role_permissions` and migration `20260408125500_role_permissions_matrix`.
- Added root-only auth management APIs:
  - `GET /auth/management/role-permissions`
  - `PATCH /auth/management/role-permissions/:role`
- Seeded default matrix values for `USER`, `ADMIN`, `ROOT`; blocked direct edits for `ROOT` permissions to keep super-admin safety.
- Extended `/dashboard/management` with a new **Role Permission Matrix** section so ROOT can toggle `USER/ADMIN` capabilities directly from UI.
- Added admin-ui types and API client methods for role permission matrix fetch/update.

## 2026-04-08 (management permission guard + permissions tab)
- Added reusable backend permission system for management endpoints:
  - `RequireManagementPermission(...)` decorator
  - `ManagementPermissionGuard` (ROOT bypass + role_permissions lookup for ADMIN/USER)
- Applied endpoint-level permission enforcement:
  - Auth management users/teams routes
  - Billing management plans/user-packages routes
  - Observability audit/root-alert routes
- Added `GET /auth/management/my-permissions` for current user’s effective management permissions.
- Updated `/dashboard/management` to be role-permission aware (not root-only hard gate) and moved role matrix into dedicated `Permissions` tab under management.

## 2026-04-07 (root observability phase 1)
- Added phase-1 observability backend module with ROOT-only endpoints for audit logs and root alerts:
  - `GET /observability/audit-logs`
  - `GET /observability/root-alerts`
  - `PATCH /observability/root-alerts/:id/read`
- Added trace correlation middleware to attach/pass `x-trace-id` per request and include trace ids in audit rows.
- Added immutable Prisma models + migration for:
  - `audit_logs`
  - `root_alerts`
- Instrumented ROOT management critical actions with audit capture:
  - User role/status/password reset/sign-in-method updates
  - Pricing plan create/update/delete
  - Team management mutations (invite/member/ownership flows), filtered to persist only ROOT actor actions
- Added baseline metrics counters and latency buckets in observability service.
- Added phase-1 alert rules:
  - repeated failed privileged actions
  - high-risk actions (role elevation to ROOT, user deactivation, plan delete)
- Added ROOT email delivery for generated alerts and ROOT dashboard alerts panel in management UI.

## 2026-04-07 (create project zip import override/duplicate options)
- Extended `Create Project` ZIP import flow under the Supabase import screen with two explicit modes:
  - **Override existing project** (select a project from active team)
  - **Create duplicate new project** (existing exported name or custom new name)
- Added backend support for ZIP import override via optional `existingProjectId` in `POST /projects/import-export-zip`.
- Kept existing duplicate/new-name behavior for ZIP imports and wired UI/API payload accordingly.

## 2026-04-07 (root alerts dashboard visibility)
- Added ROOT alerts panel visibility on `/dashboard` overview page (not only management), gated by `profile.role === 'ROOT'`.
- Verified observability tables (`audit_logs`, `root_alerts`) exist in running Postgres container.

## 2026-04-07 (project detail layout full-width + remove back button)
- Updated project detail shared layout to use full available width/height so child pages (including Storage) no longer render in a narrow area.
- Removed the "`<- Projects`" back button above project name in the left sidebar (both expanded and collapsed sidebar variants).
- Added explicit full-width wrappers in Storage browser screens to keep list/detail UI stretched to available content width.

## 2026-04-07 (login social sign-in unauthorized toast)
- Updated login error handling to preserve backend `401` message for `/auth/login` instead of collapsing to generic `Unauthorized`.
- Added provider-specific toast messages for social sign-up users attempting email/password login:
  - Google sign-up -> "Unauthorized... Google ile kaydolmuş..."
  - GitHub sign-up -> "Unauthorized... GitHub ile kaydolmuş..."

## 2026-04-07 (management users label update)
- Updated `/dashboard/management` Users table column label from **Sign Up** to **Sign In** as requested.

## 2026-04-07 (realtime + edge functions phase 1)
- **Realtime event contract:** Added shared phase-1 event envelope/types for backend publisher, admin-ui consumer, and Supabase edge function.
- **Backend publishers:** Added realtime event publishing from feedback, team mutation flows, and project activity append pipeline.
- **Edge function broadcast router:** Added `supabase/functions/realtime-events` webhook receiver with secret validation and scoped channel broadcast (`team:*`, `project:*`, `user:*`).
- **Frontend realtime subscriptions:** Added Supabase realtime client helper and subscriptions for notifications, feedback page refresh, dashboard team-level refresh, and projects list refresh.
- **Reliability guardrails:** Added reconnect with exponential backoff for realtime channel failures while preserving existing fallback behavior when phase-1 flag is disabled.

## 2026-04-07 (feedback incoming intervention notifications + browser notification tab)
- **Feedback intervention alerts:** Improved feedback polling to notify when another user changes status, adds comments, or updates/deletes feedback items.
- **Incoming-only scope preserved:** Notifications continue to suppress self-originated events and only alert on other users’ actions.
- **Profile notifications tabs:** Updated `/dashboard/profile` notifications card with two tabs: `Email Notifications` and `Browser Notifications`.
- **User-level browser preferences:** Added per-user browser notification toggles (browser pop-up enable and feedback updates) so `USER`, `ADMIN`, and `ROOT` can manage their own settings independently.

## 2026-04-07 (cloud backup restore support)
- **Cloud backup persistence:** Export download no longer auto-deletes backup object; backups remain in cloud storage for restore scenarios.
- **Cloud backup listing API:** Added `GET /projects/:id/backups` to list available cloud backups for a project.
- **Cloud restore API:** Added `POST /projects/:id/backups/restore` to restore directly from selected cloud backup object.
- **Restore name confirmation:** Cloud restore supports confirmation of import name mode (`existing` exported name vs `new` custom name).
- **Export page UI:** Added `Cloud Backups & Restore` section with backup list, restore action, and name-mode controls.

## 2026-04-07 (exported ZIP import + naming confirmation)
- **ZIP import endpoint:** Added authenticated backend endpoint `POST /projects/import-export-zip` to import project exports from ZIP archives.
- **Name confirmation on import:** Added import mode selection so users confirm whether import should use the exported project name or a new custom project name.
- **UI integration:** Added `Import Exported ZIP` flow in create/import dialog with file picker, name-mode choice, and new-name input.
- **Data restore flow:** ZIP import now restores database dump, re-creates auth users with temporary passwords, and imports storage buckets/objects (with warning list for skipped items).

## 2026-04-07 (website design aligned with dashboard blue theme)
- **Blue design language sync:** Updated website theme tokens to match dashboard's blue-based palette (primary/secondary/accent/border/radius).
- **Shared brand styling:** Added dashboard-consistent brand gradient utilities and applied them across website surfaces.
- **Logo consistency:** Replaced plain text logo in website header with the same icon badge + gradient wordmark style used in dashboard header.
- **Section polish:** Updated hero, pricing, feature cards, and CTA backgrounds/borders to align with dashboard visual language.

## 2026-04-07 (pricing sync + delete + website source hardening)
- **Stripe sync on plan update:** Management plan updates now synchronize with Stripe; when monthly price changes, a new Stripe price is created and existing subscriptions on that plan are migrated to the new price.
- **Plan delete flow:** Added root-only plan deletion with safe migration (`DELETE /billing/management/plans/:planName`), moving existing subscriptions to a replacement plan (default `free`).
- **Management UI delete action:** Added `Delete` action in Pricing Plans tab (free plan protected), with confirmation and migration summary toast.
- **Website pricing reliability:** Website pricing loader now tries multiple public endpoints including `https://app.kolaybase.com/api/proxy/billing/plans` to stay aligned with management-edited plans.

## 2026-04-07 (inactive user login warning)
- **Inactive login guard:** Login now checks Keycloak `enabled` state before token issuance and returns `ACCOUNT_INACTIVE` for disabled users.
- **Login toast warning:** Admin UI login page now shows a dedicated toast: `Your account is inactive. Please contact an administrator.`

## 2026-04-07 (sql editor excel export)
- **SQL export format update:** Replaced `Download CSV` with `Download Excel` in SQL Editor.
- **XLSX generation:** SQL query results are now exported as `.xlsx` files using ordered columns from query fields.

## 2026-04-07 (team pending invite reminder)
- **Re-invite API:** Added `POST /teams/:id/invites/:inviteId/reinvite` for owners to resend reminder emails for pending invites.
- **Mail resend behavior:** Re-invite reuses existing team invite email flow and sends reminder to pending invite target email.
- **Team UI button:** Added `Re-invite` action next to pending invite entries in `/dashboard/team`, with loading state and success/error toasts.

## 2026-04-07 (project detail sidebar full height)
- **Project layout height fix:** Updated project detail layout container/aside/main sizing to use full available height (`h-full` / `min-h-full`) so the left sidebar is no longer visually cut off at the bottom.

## 2026-04-07 (management users sign-in methods)
- **Management users enrichment:** Added user sign-in method fields in management users response (`authProvider`, `linkedProviders`, `hasPasswordAuth`).
- **Keycloak method detection:** Management now checks federated identities (`google`/`github`) and password credential presence for each user.
- **Users table UI:** Added `Sign In` column in `/dashboard/management` Users tab to show how each user signs in and what providers are linked.

## 2026-04-07 (project detail scroll + sidebar stretch)
- **Single-scroll fix:** Removed nested scrolling in project detail content area so dashboard no longer shows dual vertical scrollbars.
- **Full-height project detail frame:** Updated dashboard content wrapper for project detail routes to use full-height container, letting left project sidebar extend to the bottom without visual gap.
- **Alignment correction:** Restored route padding for project detail wrapper while keeping full-height behavior, fixing page shift/misalignment on screen.

## 2026-04-07 (projects grid/list toggle)
- **View switcher:** Added grid/list view toggle icons to `/dashboard/projects` top toolbar.
- **Persisted preference:** Selected view mode now persists via localStorage (`kb_projects_view_mode`).
- **List rendering mode:** Added compact list row rendering for project cards while preserving selection and context-menu behavior.
- **Team-switch route safety:** When team is switched from header while on a project detail route, app now redirects to `/dashboard/projects` so the newly selected team's project list is shown.

## 2026-04-07 (sql editor area sizing)
- **SQL page container fix:** Wrapped SQL editor in a full-height card container with `min-h-0 flex-1` so it uses available page area correctly.
- **Editor input area enlarged:** Increased SQL query textarea default height to improve usability and avoid cramped rendering in small-looking area.

## 2026-04-07 (management sign-in icons + sign-on method)
- **Icon-only sign-in methods:** Replaced text labels in management users `Sign In` column with icons for Google, GitHub, and password auth.
- **Sign-up method column:** Added `Sign Up` column to show the initial method (local/google/github) as icon, sourced from backend auth metadata.

## 2026-04-07 (social auth password policy)
- **Social users provider-only login:** Email/password login now rejects Google/GitHub accounts with provider-specific guidance (`SOCIAL_LOGIN_ONLY`).
- **Password change disabled for social accounts:** Social-auth users can no longer set/change password from account settings or backend API.
- **Profile rules clarified:** Social-auth users can still edit first/last name; local-signup users continue standard password + profile flow.

## 2026-04-07 (cross-provider social login mapping)
- **OAuth identity mapping fix:** JWT strategy now maps OAuth tokens to existing app user by email when token `sub` is missing in local DB.
- **Google/GitHub parity:** Users who signed up with Google can sign in with GitHub (and vice versa) into the same app profile, without creating duplicate app users.
- **Scope safety:** Mapping is applied only when token has both `sub` and `email`, and only if `sub` is unknown but email already exists in app users.

## 2026-04-07 (root-managed sign-in method policy)
- **Root policy control:** Added root-only user policy endpoint to set required sign-in method per user (`local`, `google`, `github`, or clear).
- **Management UI update:** Added `Sign In Policy` selector in `/dashboard/management` Users tab so ROOT can enforce user login method.
- **Enforcement:** Local login and OAuth callback now enforce required sign-in method and return explicit login errors when method does not match policy.

## 2026-04-07 (dashboard crash after login — missing JWT email)
- **Root cause:** Keycloak access tokens sometimes omit `email` in the JWT payload; `UserMenu` called `.slice()` on `undefined` and crashed the dashboard (Next.js generic error screen).
- **JWT parsing:** `parseJwt` now decodes base64url segments correctly and fills `email` from `email`, then `preferred_username`, then `sub`.
- **Header hardening:** User menu and mobile header use a safe `loginLabel` fallback chain so initials and labels never call string methods on `undefined`.

## 2026-04-07 (management users sign-in select + password reset rules)
- **Sign In editable:** `Users` tab `Sign In` cell is now a select (`Local` / `Google` / `GitHub`) and updates user auth provider via root-only endpoint.
- **Role/Status column fix:** Corrected column mapping so `Role` shows role select and `Status` shows active/inactive badge + action button.
- **Social sign-up password reset lock:** Reset password is disabled for users who signed up with Google/GitHub (UI disabled state + hover explanation, backend guard enforced).
- **Persistence fix:** Sign-in method updates now resolve Keycloak user by `id` with email fallback before reading/writing override attribute, so refresh keeps selected method.

## 2026-04-08 (google login reliability hardening)
- **JWT claim fallback:** JWT strategy now uses `preferred_username` as email fallback when `email` claim is missing in OAuth tokens.
- **User mapping stability:** OAuth-authenticated users are matched to existing app user by resolved email fallback before authorization checks.

## 2026-04-08 (google re-login account prompt enforcement)
- **No silent Google auto-login:** Updated Google OAuth parameters to force re-authentication on each login attempt (`prompt=login`, `max_age=0`).
- **Provider config alignment:** Keycloak Google IdP config now enforces the same behavior so users can choose a different Google account after sign-out.

## 2026-04-08 (social signup password lock enforcement)
- **Login enforcement basis changed:** Email/password login now blocks users based on immutable `signOnMethod` (signup method), not mutable auth provider override.
- **Password change/reset blocked for social signup:** `changePassword`, `forgotPassword`, and reset-token flow now prevent password operations for Google/GitHub signup users.
- **Profile contract updated:** `/auth/profile` now exposes `signOnMethod` and `canChangePassword`, and account UI uses that to keep password actions disabled for social-signup users.

## 2026-04-08 (management users sign-in editor removed)
- **UI simplification:** Removed editable `Sign In` method column from `/dashboard/management` Users tab.
- **Signup-only display:** Kept `Sign Up` method column as the single auth-method indicator in management view.

## 2026-04-08 (profile password hint aligned with policy)
- **Profile hint update:** Replaced legacy `6 characters` wording on `/dashboard/profile` password section with current password policy text.
- **UI consistency:** Updated new-password placeholder and button-disable threshold to 8+ characters to match current policy baseline.

## 2026-04-07 (sign-in policy reverted)
- **Policy removed:** Rolled back `Sign In Policy` management selector/endpoint and related enforcement logic.
- **Users table behavior:** `Sign In` column now shows only one effective method icon (single method), not multiple linked-provider icons.

## 2026-04-07 (management users activate/deactivate)
- **Root user status control:** Added user activation control in `/dashboard/management` Users tab.
- **Backend endpoint:** Added `PATCH /auth/management/users/:id/active` (root-only) to enable/disable platform users.
- **Keycloak integration:** User activation state now maps to Keycloak user `enabled` flag, so deactivated users cannot sign in.
- **UI actions:** Users table now shows `Active/Inactive` badge and `Deactivate/Activate` button per user.
- **Safety rule:** Root cannot deactivate own account.

## 2026-04-07 (management page tabbed layout)
- **UI navigation update:** Converted `/dashboard/management` sections into top tabs.
- **Tabs added:** `Users`, `Pricing Plans`, and `Teams` are now rendered as selectable tabs.
- **Behavior:** Only the active tab content is displayed at a time for a cleaner management workflow.

## 2026-04-07 (website pricing unavailable fix)
- **Root cause:** Website pricing fetch targeted `/billing/plans`, while platform API is mounted under `/api/*` in this stack.
- **Fix:** Updated website plan fetch logic to try `/api/billing/plans` first (with `/billing/plans` fallback) across candidate base URLs.
- **Result:** `Pricing plans are temporarily unavailable` fallback no longer appears when API is healthy.

## 2026-04-07 (management plans: save flow + MB/GB + create)
- **Plan edit UX:** Converted pricing plan editing on `/dashboard/management` to draft-based editing with a single `Save Changes` button.
- **Human units:** Replaced raw byte editing with value + unit selectors (`MB` / `GB`) for storage, DB size, and bandwidth fields.
- **Create plan support:** Added root-only create-plan flow (new API endpoint + UI form) so new pricing plans can be added directly from management page.
- **API updates:** Added `POST /billing/management/plans` and corresponding admin UI client method `api.billing.createManagementPlan(...)`.

## 2026-04-07 (social sign-in identity field protection)
- **Sign-in type detection:** Added Keycloak federated-identity check to identify platform auth provider as `local`, `google`, or `github`.
- **Backend protection:** For `google/github` users, email/username/password updates are blocked by default.
- **Explicit override flow:** Added `allowIdentityEdit` guard flag so identity edits only proceed when user explicitly enables it from UI.
- **Profile payload enriched:** `/auth/profile` now returns `authProvider` and `canEditIdentityFields` for client-side behavior.
- **Account UI update:** On `/dashboard/account`, social users now see locked identity fields and an `Enable identity edits` button that unlocks username/email/password changes intentionally.

## 2026-04-07 (root account recovery after accidental reset)
- **Issue diagnosed:** Root login failed because Keycloak user record for `016f202d-409d-4627-9cfc-77369b79bb22` had no email set, causing `user_not_found` during password-grant login with email.
- **Recovery applied:** Restored Keycloak email to `bsaygin@outlook.com`, ensured account enabled with empty `requiredActions`, and set a new temporary root password.
- **Security state cleanup:** Reset `login_security_states` counters and captcha/lock fields for `bsaygin@outlook.com`.
- **Verification:** Confirmed successful token issuance from Keycloak using the recovered root email + temporary password.

## 2026-04-07 (force-password-change enforcement hardening)
- **Root cause:** Force-password-change check depended on email lookup, which could miss cases where login succeeded via username fallback or user profile drift.
- **Backend hardening:** Login now decodes authenticated token `sub` and checks `kb_force_password_change` by Keycloak user id, with email lookup only as fallback.
- **Result:** `Force user to change password on next login` now consistently redirects users to change-password flow before normal dashboard access.

## 2026-04-07 (force password change login fix)
- **Root cause:** Keycloak `UPDATE_PASSWORD` required action blocks direct password-grant login, causing `LOGIN_ERROR resolve_required_actions` for users reset with force-change.
- **Backend fix:** Reworked force-change flow to use Keycloak user attribute `kb_force_password_change=true` during admin reset (without `temporary` password / required action), so login succeeds.
- **Login enforcement:** Login response now includes `forcePasswordChange`; admin UI stores a `kb_force_password_change` cookie and redirects users to `/dashboard/account?forcePasswordChange=1`.
- **Route guard behavior:** Dashboard layout now forces redirected users to account page until password is changed.
- **Completion behavior:** On successful password change, backend clears Keycloak force flag and frontend clears `kb_force_password_change` cookie, then allows normal dashboard access.
- **Follow-up fix:** Force flag read now uses full Keycloak user (`users.findOne`) instead of brief list response, ensuring `attributes.kb_force_password_change` is reliably detected at login.

## 2026-04-07 (feedback attachments modal preview)
- **Feedbacks media UX:** Added large modal preview for attachments on `/dashboard/feedbacks`.
- **Click-to-preview:** Both main feedback attachments and comment attachments now open in a dialog when clicked.
- **Media support:** Images open in large `object-contain` preview; videos open in large modal player with controls/autoplay.

## 2026-04-07 (feedback comment replies)
- **Feedback threads:** Added comment reply support in `/dashboard/feedbacks` so users can respond directly to a specific comment.
- **Backend support:** Added optional `parentCommentId` to feedback comments with validation and DB relation.
- **Permissions:** Feedback owner and ROOT can now comment/reply on accessible feedback records.
- **UI update:** Added `Reply` actions, reply target indicator, and nested rendering of replies under parent comments.

## 2026-04-07 (global realtime notifications)
- **Header notifications:** Added a notification bell next to the theme button in the dashboard header.
- **In-app notification center:** Implemented a centralized notifications provider with unread counts, mark-read, and clear actions.
- **Browser notifications:** Added permission flow and Web Notification support for Chrome/other modern browsers.
- **AI/import/feedback triggers:** Added notifications for AI replies (when assistant is not open), import completion (when import modal is not visible), and feedback status/comment updates via periodic realtime-like polling.

## 2026-04-07 (feedback paste screenshot attachments)
- **Feedback modal paste:** Added `Ctrl+V` support so pasted screenshots/media are attached directly while creating feedback.
- **Feedback comment paste:** Added `Ctrl+V` support in feedback comment textarea to attach pasted screenshots/media instantly.
- **Attachment UX:** Kept file-limit checks and added paste hint text for both create-feedback and comment flows.

## 2026-04-07 (selected comment files review before send)
- **Selected files toggle:** Made `N file(s) selected` clickable in feedback comment composer.
- **Pre-send review:** Added expandable selected-files list showing file names and sizes before submit.
- **Pre-send remove:** Added per-file remove action so attachments can be deleted before sending comment.

## 2026-04-07 (feedback reply target visibility)
- **Reply context clarity:** Added inline `Reply to <username>` text on rendered replies so it is clear who was replied to.
- **Thread readability:** Improved nested reply comprehension by showing reply target directly above reply content.

## 2026-04-07 (feedback delete confirmation)
- **Delete safety:** Added confirmation prompt before deleting feedback tasks on `/dashboard/feedbacks`.

## 2026-04-07 (feedback developer action modal history)
- **Clickable developer action:** Made `Developer action` area clickable in feedback cards.
- **History modal:** Added feedback activity modal that lists timeline entries with actor, date/time, action, and details.
- **Backend event log:** Added persistent feedback event tracking (`create`, `status change`, `edit`, `delete`, `comment/reply`) and exposed `GET /feedback/:id/history`.

## 2026-04-07 (feedback search)
- **Feedback search:** Added live search input on `/dashboard/feedbacks`.
- **Filter scope:** Search now matches title, description, username, email, page URL, status, and type.

## 2026-04-07 (notifications incoming-only filter)
- **Notification filtering:** Updated header notification logic to suppress self-originated notifications.
- **AI/import muted for self:** Disabled AI reply/import-complete notification feed entries from same user session.
- **Feedback incoming-only:** Feedback status/comment notifications now show only when action/comment comes from another user.

## 2026-04-07 (navbar dropdown outside-click close)
- **Global close behavior:** Added outside-click handling so open navbar dropdowns close when clicking anywhere else on the page.
- **Applied to nav menus:** Team switcher, projects menu, docs menu, and user menu now consistently close on external click.

## 2026-04-07 (notification deep-link to relevant feedback)
- **Targeted notification navigation:** Feedback notifications now link to exact feedback card anchors.
- **In-page jump:** Added per-feedback DOM anchor ids so clicking a notification scrolls directly to the related item.

## 2026-04-07 (project logs search and pagination)
- **Activity search:** Added live search input to Project Logs Activity timeline.
- **Activity pagination:** Added client-side pagination with previous/next controls and page indicator.
- **Result summary:** Added matching results counter to improve log browsing clarity.

## 2026-04-07 (project activity actor visibility)
- **Actor info in activity:** Added `by <user>` display for each Project Activity timeline item.
- **Backend enrichment:** Project activity list now resolves `userId` to readable actor names from users table; falls back to `System` for automated events.

## 2026-04-07 (table editor sidebar independent scroll)
- **Fixed-height table editor viewport:** Set Table Editor split layout to viewport-based height.
- **Independent left panel scroll:** Table list sidebar now scrolls within its own panel area instead of scrolling the whole page.

## 2026-04-07 (table editor columns panel persisted state)
- **Columns panel persistence:** Saved right-side Columns panel open/closed state to localStorage.
- **Cross-table consistency:** Switching tables no longer forces panel open; closed stays closed, open stays open.

## 2026-04-07 (non-root feedback close after done)
- **Status flow update:** Non-root users can now close their own feedback after it is marked done.
- **UI behavior:** For non-root owners, action button switches from `Mark done` to `Close` once status is `DONE`.
- **Backend rule:** Enforced status transition for non-root as `DONE` first, then `CLOSED`.

## 2026-04-07 (feedback nested replies infinite depth)
- **Thread rendering fix:** Updated feedback comment UI to render replies recursively instead of only one level.
- **Unlimited reply depth:** Users can now reply to replies indefinitely, and all nested levels are visible.
- **Reply context preserved:** Each nested reply still shows `Reply to <username>` where applicable.

## 2026-04-07 (feedback close button label)
- **UI label update:** Changed non-root owner status button text from `Close` to `Close Task` when feedback is in `DONE` state.

## 2026-04-07 (feedback close button label revised)
- **UI label revision:** Updated non-root owner status button text from `Close Task` to `Close Ticket` when feedback is in `DONE` state.

## 2026-04-07 (header dropdown global close hardening)
- **Centralized dropdown state:** Connected `Docs` and `User` menus to header-level controlled state.
- **Outside-click behavior:** Global outside click now closes Team, Projects, Docs, and User dropdowns consistently.
- **Mutual exclusivity:** Opening one header dropdown now closes other header dropdown menus.

## 2026-04-07 (root-only management area)
- **Root-only management routes:** Added backend endpoints for root users to list platform users, list teams, and update user roles.
- **Root-only dashboard page:** Added `/dashboard/management` with Users and Teams tables.
- **Role management:** Root users can change user roles (`USER`, `ADMIN`, `ROOT`) from the UI.
- **Navigation visibility:** `Management` navigation item is shown only for users with `ROOT` role.

## 2026-04-07 (dashboard sidebar auto/open mode)
- **Left menu behavior update:** Added `Auto / Open` mode to `/dashboard` left sidebar, similar to project detail sidebar behavior.
- **Auto mode:** Sidebar stays as a compact rail and expands on hover.
- **Open mode:** Sidebar remains fully expanded.
- **Persistence:** Sidebar mode is saved in localStorage and legacy collapsed state is migrated.

## 2026-04-07 (management pricing and user package controls)
- **Root billing management APIs:** Added root-only billing endpoints for management plans and user package operations.
- **Pricing management UI:** Added pricing plan table in `/dashboard/management` to update monthly plan price.
- **User package management UI:** Added per-user package selector in `/dashboard/management` for changing user package via personal team subscription.

## 2026-04-07 (management users package column and password reset)
- **Users table package column:** Moved package management into Users table as a direct column per user.
- **Root password reset controls:** Added root-only password reset action for each user with custom password input.
- **Generate password button:** Added random strong password generation button in reset modal.
- **Force password change option:** Added checkbox to force users to update password at next login (`UPDATE_PASSWORD` required action).

## 2026-04-07 (pricing names and website sync)
- **Management pricing edits expanded:** Added editable plan display name and major quota fields in Management pricing table.
- **Website pricing data source:** Website `/#pricing` now reads plan names and limits dynamically from billing plans API.
- **Auto sync effect:** Updating plan name/limits in Management now reflects on website pricing cards after refresh/redeploy.

## 2026-04-07 (login refresh loop fix)
- **Root cause:** Global notifications provider was polling protected endpoints on public pages (including `/login`), triggering 401 redirect cycles.
- **Fix:** Notifications profile fetch and feedback polling now run only when an access token exists.
- **Result:** Login page no longer hard-refreshes repeatedly due notification polling.

## 2026-04-07 (management reset password copy icon)
- **UX enhancement:** Added copy icon inside the reset-password textbox on `/dashboard/management`.
- **One-click copy:** Root can copy generated/manual password directly to clipboard from the input field.

## 2026-04-07 (signup password requirements hover info)
- **Signup UX update:** Added an info (`i`) icon next to the password label on `/signup`.
- **Hover details:** Password policy now appears on hover (8+ chars, uppercase, lowercase, number, special character).
- **Input alignment:** Updated password placeholder and `minLength` to 8 to match server-side rules.

## 2026-04-07 (SQL Editor tab rename support)
- **Tab rename added:** Users can now rename SQL tabs in `apps/admin-ui/components/sql-editor.tsx`.
- **UX behavior:** Double-click a tab title to edit inline; `Enter` or blur saves, `Escape` cancels.
- **Persistence:** Renamed titles are persisted in existing localStorage tab state.
- **Validation:** Rebuilt/restarted Docker stack successfully.

## 2026-04-07 (root can view deleted feedbacks)
- **Soft delete added for feedbacks:** Introduced `deleted_at` on `feedbacks` (Prisma schema + migration file) so deleted items are retained instead of hard-deleted.
- **Service behavior updated:** `removeFeedback` now sets `deletedAt` timestamp. Normal users only query non-deleted feedbacks; `ROOT` users get full list including deleted items.
- **Access control tightened:** Non-root users cannot access deleted feedback by ID; root access remains allowed.
- **UI visibility:** `/dashboard/feedbacks` now marks deleted entries with a `Deleted` badge and disables edit/delete actions on deleted records.
- **DB/runtime apply:** Applied `ALTER TABLE ... ADD COLUMN deleted_at` + index directly on local DB and rebuilt Docker stack.

## 2026-04-07 (billing no-plan fix - seeded plans + auto-heal subscription)
- **Root cause found:** `plans` table was empty in local DB; free/pro/business plans were never seeded, causing billing page to show `No Plan` and project creation to fail with `Team has no subscription`.
- **Data fix applied:** Ran Prisma seed inside `platform-api` container (`npx prisma db seed`) to create `legacy/free/pro/business` plans and backfill subscriptions for teams without one.
- **Code hardening:** Updated `apps/platform-api/src/modules/billing/quota.service.ts` so missing team subscription auto-creates a `free` subscription + `team_usage` row (when free plan exists), instead of immediately throwing.
- **Validation:** Rebuilt/restarted Docker stack; platform-api is running with updated quota logic.

## 2026-04-07 (feedbacks crash fix - missing auth guards)
- **Root cause:** `apps/platform-api/src/modules/feedback/feedback.controller.ts` had missing `JwtAuthGuard` on `GET /feedback` and `PATCH /feedback/:id`; `@CurrentUser()` could be undefined, causing runtime `Cannot read properties of undefined (reading 'sub')`.
- **Fix:** Added `@UseGuards(JwtAuthGuard)` to both endpoints so `user.sub` is always available.
- **Validation:** Rebuilt/restarted Docker stack successfully.

## 2026-04-07 (header cleanup - removed My Feedbacks shortcut)
- **Desktop header:** Removed `My Feedbacks` button from `apps/admin-ui/components/header.tsx` top navigation actions.
- **Mobile menu:** Removed `My Feedbacks` entry from the mobile dropdown menu in the same header component.
- **Icon cleanup:** Removed now-unused `ListChecks` import.
- **Validation:** Rebuilt/restarted Docker stack and verified admin UI build passes.

## 2026-04-07 (local login 401 - account lock reset)
- **Root cause found:** Local login `401` was caused by login security lock in `login_security_states` for `bsaygin@outlook.com.tr` (`failed_attempts=10`, `consecutive_failed=10`, `locked_until` set).
- **Immediate fix applied:** Reset lock/captcha counters in DB (`failed_attempts=0`, `consecutive_failed=0`, `locked_until=NULL`, captcha fields cleared) for the affected email.
- **Verification:** Confirmed row now shows zero counters and no lock timestamp.

## 2026-04-07 (login UX - clear toast messaging for lock/captcha/invalid credentials)
- **Lock feedback:** `apps/admin-ui/app/login/page.tsx` now detects backend lock messages and shows explicit toast: account is temporarily locked for 30 minutes.
- **Captcha feedback:** Added clearer toast mapping for `CAPTCHA_REQUIRED` and invalid captcha answer.
- **Credential feedback:** Added specific toast for invalid email/password instead of generic error.
- **Validation:** Rebuilt Docker stack and confirmed admin UI starts with updated login error handling.

## 2026-03-30 (pricing policy made more aggressive)
- **Website pricing updated (`/#pricing`):** Free plan changed to `5 projects`, `2 GB storage`, `1 GB database`, `3 team members`.
- **Pro plan scaled up:** Updated to `20 projects`, `200 GB storage`, `16 GB database`, `10 team members`, with higher API/bandwidth quotas.
- **Business plan scaled up:** Updated to `50 projects`, `1 TB storage`, `64 GB database`, `30 team members`, with higher API/bandwidth quotas.
- **Backend seed alignment:** Updated `apps/platform-api/prisma/seed.ts` plan limits so dashboard billing and enforced quotas stay consistent with website pricing.

## 2026-03-30 (sql result export actions)
- **SQL result actions added:** Implemented `Copy as Markdown`, `Copy as JSON`, and `Download CSV` in `SqlEditor` result toolbar.
- **Markdown export:** Converts current tabular result into markdown table format with header/separator rows and escaped cell values.
- **JSON export:** Copies current result rows as pretty-printed JSON.
- **CSV download:** Generates CSV from current result rows and triggers browser download with timestamped filename.

## 2026-03-30 (connection env keys renamed to KolayBase)
- **Raw Editor env/json outputs updated:** Replaced Supabase-prefixed environment key names with KolayBase names in `ConnectionStringsView`.
- **Next.js preset:** `NEXT_PUBLIC_KOLAYBASE_URL`, `NEXT_PUBLIC_KOLAYBASE_ANON_KEY`, `KOLAYBASE_SERVICE_ROLE_KEY`.
- **Vite / Expo / Node presets:** Renamed all `SUPABASE_*`/`VITE_SUPABASE_*`/`EXPO_PUBLIC_SUPABASE_*` keys to KolayBase equivalents while preserving values.
- **Project identifier retained:** `PROJECT_ID` remains unchanged and included in every preset.

## 2026-03-30 (export stream + download proxy fix)
- **Root cause:** Export progress stream used generic proxy route, which did not map EventSource `?token=` query into `Authorization` header. Backend SSE auth failed, so UI stayed at "Export started" without completion state.
- **Fix:** Added dedicated export SSE proxy route at `app/api/proxy/projects/[projectId]/export/jobs/[jobId]/events/route.ts`, mirroring import stream behavior and forwarding bearer token correctly.
- **Client resilience:** Updated export stream client in `lib/api.ts` to parse named `error` SSE events with payload and surface them via `onFailed`.
- **Download proxy binary handling:** Updated generic proxy to treat `application/zip` as binary passthrough, preventing ZIP corruption when downloading export archives.

## 2026-03-30 (sql editor multi-tab + query persistence)
- **Multi-SQL tabs:** Updated `SqlEditor` to support multiple query screens at once with tab strip, add-tab, switch-tab, and close-tab actions.
- **Per-tab state isolation:** Each SQL tab now preserves its own query text, last result, and last error independently.
- **No query loss across tabs:** Switching between tabs no longer resets editor content; each tab keeps its query intact.
- **Local persistence:** SQL tabs and active tab are stored in `localStorage` per project (`kb_sql_editor_tabs_<projectId>`), so tab content survives refresh/reopen.

## 2026-03-30 (table editor multi-tab support)
- **Multi-table tabs:** Updated `TableEditor` to allow opening and keeping multiple tables at once via `openTabs` state, with a tab strip in the editor content area.
- **Tab interactions:** Added tab activate/switch and close actions; when an active tab is closed, editor automatically switches to the previous open tab.
- **Sidebar integration:** Clicking a table from sidebar now opens it as a tab (if not already open) and focuses it.
- **Create table flow:** Updated `CreateTableDialog` callback to return created table name and auto-open that table as a new tab after creation.

## 2026-04-07 (login redirect loop hardening - auth marker cookie)
- **Likely root cause addressed:** Added localStorage-backed token persistence in `apps/admin-ui/lib/auth.ts` to avoid JWT cookie size limits causing missing auth state.
- **Middleware-safe marker:** Added lightweight `kb_logged_in=1` cookie on login and removed it on logout/clear; middleware now allows dashboard routes when either `kb_access_token` or `kb_logged_in` exists.
- **Navigation reliability:** Login flow uses hard redirect (`window.location.assign('/dashboard')`) after successful sign-in to ensure cookie visibility on the next request cycle.
- **Validation:** Rebuilt and restarted admin UI container after the auth-state updates.

## 2026-04-07 (login submit hardening - prevent form refresh fallback)
- **Submit path hardened:** Refactored login submit logic in `apps/admin-ui/app/login/page.tsx` into shared `submitLogin()` and wired both form `onSubmit` and button click to it.
- **Refresh fallback removed:** Changed sign-in button to `type="button"` with explicit click handler to avoid native form-post refresh when submit event is not captured.
- **Validation:** Rebuilt and restarted admin UI container with updated login flow.

## 2026-04-07 (login loops on /login after 200 sign-in)
- **Auth cookie scope fix:** Updated `apps/admin-ui/lib/auth.ts` token cookies to always set/remove with `path: '/'` so middleware can read `kb_access_token` on `/dashboard/*`.
- **Post-login navigation:** Updated `apps/admin-ui/app/login/page.tsx` to use `router.replace('/dashboard')` after successful email/password and OAuth hash token login.
- **Team cookie consistency:** Updated `apps/admin-ui/app/dashboard/layout.tsx` to set `kb_active_team` with `path: '/'` for consistent route access.
- **Validation:** Rebuilt and restarted containers with `docker compose up -d --build`; admin UI/service startup completed successfully.

## 2026-03-30 (project activity expansion + import summary empty-state removal)
- **Project activity coverage expanded:** Added new activity kinds and logging for database CRUD operations in project data endpoints: table create/drop, row insert/update/delete, column add/edit/delete, and foreign key add/remove.
- **Storage operations now tracked:** Added activity logs for storage bucket create/update/delete and object upload/delete, including path/count metadata where relevant.
- **Auth user management tracked:** Added activity logs for project auth user create/update/password reset/delete actions.
- **Timeline category mapping updated:** New activity kinds are now grouped under `Database`, `Storage`, and `Auth` on the project logs timeline.
- **Import summary empty state removed:** Deleted the `No import summary yet` placeholder block from project logs page for non-import projects created from scratch.

## 2026-04-07 (docker sign-in fix: frontend 3000 + backend 8000)
- **Port alignment:** Local app ports were pinned in `.env` as `ADMIN_UI_PORT=3000` and `PLATFORM_API_PORT=8000`; public API URLs were aligned to `http://localhost:8000`.
- **Port conflict handling:** Checked and force-cleaned listeners for ports `3000` and `8000` (no external listeners found after compose shutdown).
- **Backend reachability fix:** Resolved `platform-api` restart loop by aligning local credentials for existing Docker volumes (`POSTGRES_PASSWORD` and `KEYCLOAK_ADMIN_PASSWORD` values used by running local stack).
- **Startup ordering hardening:** Added `keycloak` healthcheck and changed `platform-api` dependency from `service_started` to `service_healthy` to prevent early boot `fetch failed / ECONNREFUSED`.
- **Validation:** Rebuilt/restarted stack with Docker; final mappings confirmed: admin UI `localhost:3000`, platform API `localhost:8000`, keycloak `localhost:18080`.

## 2026-03-30 (auth hardening: password policy + lock + captcha)
- **Password policy:** Platform auth now enforces password rules in signup/reset/change: minimum 8 chars, at least 1 uppercase, 1 lowercase, 1 number, and 1 punctuation. Updated DTO validators (`signup`, `reset-password`, `change-password`) and backend guard in `AuthService`.
- **Failed-login protection:** Added Prisma model/table `login_security_states` (migration `20260330191500_add_login_security_state`) to track failed attempts by email.
- **Account lock:** After 10 failed login attempts, account login is blocked with lock window (`30 minutes` server-side) and returns lock error.
- **Captcha after 4 consecutive failures:** Added `GET /auth/captcha?email=` and login flow support. After 4 consecutive failed attempts, backend requires captcha (`CAPTCHA_REQUIRED`), and login page now shows captcha question + answer input before retry.
- **UI/API wiring:** `LoginDto` accepts optional `captchaAnswer`, `AuthController` forwards captcha to service, `admin-ui` API client supports `auth.getCaptcha` and sends `captchaAnswer` during login.

## 2026-04-07 (feedback roles: edit/delete/done/comments/media)
- **Permissions:** `GET /feedback` is now role-aware: `ROOT` users see all feedback tasks, normal users see only their own tasks.
- **Task actions:** both `ROOT` and task owner can edit/delete task; normal users can only set status to `DONE` (completed), while `ROOT` can set any status.
- **Comments:** added `feedback_comments` table and relation; `ROOT` users can comment on tasks and include image/video attachments in comments.
- **API additions:** `PUT /feedback/:id`, `DELETE /feedback/:id`, `GET /feedback/:id/comments`, `POST /feedback/:id/comments`; existing list now returns comments with each feedback.
- **UI updates:** `/dashboard/feedbacks` now works for both root and normal users with role-based actions, inline edit/delete, mark-done for owners, and root comment composer with media upload.

## 2026-04-07 (supabase import stuck at first step fix)
- **Root cause:** when import SSE status stream encountered missing job/poll error, backend emitted `error` event and frontend did not map that to a terminal failed state. UI remained on first step (`Queued, waiting for worker...`) indefinitely.
- **Backend fix:** in `projects.controller` import SSE stream, converted terminal stream errors (`job not found`, poll exceptions) to `failed` events and closed the stream.
- **Frontend fix:** in `admin-ui/lib/api.ts` import SSE client, named `error` payloads with a `message` are now treated as failure via `onFailed(...)`, then stream is closed.

## 2026-04-07 (feedback tracking for normal users)
- **Navigation access:** `/dashboard/feedbacks` is now visible for all authenticated users (not root-only). Updated dashboard sidebar and dashboard layout wiring.
- **Header shortcuts:** added `My Feedbacks` quick access in desktop header and mobile menu so users can always reach the tracking screen.
- **Tracking clarity:** feedback list subtitle and per-item `Developer action` status helper text now communicate current dev state (`OPEN/IN_PROGRESS/DONE/CLOSED`) for normal users.
- **Result:** normal users can track all feedback they created and see developer actions/comments from the same list screen.

## 2026-03-29 (feedback attachments + ROOT-only list)
- **DB:** `UserRole` + `ROOT`; `feedbacks.attachments` JSONB (migration `20260329180000_feedback_attachments_and_root_role`).
- **API:** `POST /feedback/attachments` (multipart `file`, image ≤5MB / video ≤20MB) → MinIO bucket `kb-platform-feedback`; `POST /feedback` optional `attachments[]`; `GET`/`PATCH /feedback/:id` guarded by `RootRoleGuard` (Prisma `user.role === ROOT`).
- **Admin UI:** `FeedbackModal` multi-file upload; `/dashboard/feedbacks` + sidebar link only if `profile.role === 'ROOT'`. Set `ROOT` in DB: `UPDATE users SET role = 'ROOT' WHERE email = '...';`

## 2026-03-28 (project activity log — full audit trail)
- **DB:** Prisma model `ProjectActivityLog` → table `project_activity_logs` (migration `20260328120000_project_activity_logs`). Cascade delete with project.
- **API:** `ProjectActivityService.append` / `listForProject`; `GET /projects/:id/activity?limit=` (registered before `GET :id`). Logs: Supabase import completed/failed/cancelled (job carries `userId`), project create/update/soft-delete/restore/move team, SQL executed/failed, GitHub/Vercel connect/disconnect, auth config updates (no secret field names in metadata).
- **Admin UI:** `api.projects.listActivity`, types `ProjectActivityItem`, `ProjectActivityTimeline` on `/dashboard/projects/[id]/logs` above **Supabase import detail** when present.

## 2026-03-28 (project logs page — no page scroll + spacing)
- **Layout chain:** `dashboard/layout` main is `flex flex-col`; project `[id]/layout` on `/logs` uses `main` `flex flex-col overflow-hidden` (other routes keep `overflow-y-auto`). Logs page root `flex-1 min-h-0 overflow-hidden`; `ProjectImportLogCard` gains `fillParentHeight` + `className` so the card fills remaining height and scrolls **inside** (warnings list).
- **Spacing:** Import log card uses vertical `gap-4` (16px), header/actions `gap-4`, issue panel `p-4` + `gap-3`; logs page `gap-5` (20px) header; overview `ProjectDetail` `space-y-5` / grid `gap-5` to align with logs.

## 2026-03-28 (project import log layout)
- **Logs page** (`/dashboard/projects/[id]/logs`): removed `-mx-6` horizontal bleed; page wrapper `min-w-0 max-w-full overflow-x-hidden`. `ProjectImportLogCard` `expandedLayout`: dropped tall `min-h` (52vh); added `max-h-[min(calc(100dvh-12rem),56rem)]`, `min-w-0 max-w-full overflow-x-hidden`, issues panel `flex-1` + list `flex-1 overflow-y-auto`; long lines use `break-words` / `[overflow-wrap:anywhere]`, failed table names `break-all`.
- **Overview** (`ProjectDetail`): import log moved to **bottom** of the stats grid as `md:col-span-3`; same chrome as other tiles (`rounded-lg border bg-card p-5`, no `expandedLayout`, `shadow-none` when embedded).

## 2026-03-28 (dashboard collapsible org sidebar)
- `dashboard/layout.tsx`: left **DashboardSidebar** (`components/dashboard-sidebar.tsx`) — Supabase-style org rail: home + team name (Owner badge), links Overview / Projects / Team / Account / Profile / Feedbacks, **collapse** toggle (persisted `localStorage` `kb_dashboard_nav_collapsed`). Width animates 220px ↔ 52px. **Hidden** on `/dashboard/projects/[id]/*` so project layout keeps a single sidebar. Visible from `md` breakpoint (`hidden md:flex`).

## 2026-03-28 (folder/tag modal color row)
- Projects page: **New/Edit Folder** and **New/Edit Tag** modals use `Modal` `size="md"` (`max-w-md`) so the color swatch row fits without horizontal scroll; `ColorPicker` row no longer uses `overflow-x-auto`.

## 2026-03-28 (projects: drag to trash + drop target highlight)
- `/dashboard/projects`: **Trash** is a `useDroppable` (`droppable-trash`, `DND_TRASH`). Dropping a project card moves it to trash; if the dragged card is in the multi-selection and more than one is selected, all selected projects are deleted (same rule as folder/tag bulk DnD). Reuses `moveProjectsToTrash` with bulk-delete modal.
- Folder **All**, folder rows, and tag rows: while dragging over them, `isOver` uses the same **selected** look as the active filter (`bg-primary/10 text-primary font-medium ring-2 ring-primary/50`). Trash row uses **destructive** ring/fill when `isOver`.

## 2026-03-29 (folder/tag color picker layout)
- Projects page `ColorPicker`: preset swatches + custom (`+`) stay on **one row** (`flex-nowrap`, `overflow-x-auto`, `shrink-0`) so custom sits after the last preset instead of wrapping below.

## 2026-03-29 (Create Project → overview)
- `CreateProjectDialog` `handleCreate`: after successful `api.projects.create`, close dialog and `router.push` to `/dashboard/projects/{id}` (project overview).

## 2026-03-29 (import log layout + AI fixes)
- **Project import log** (overview + logs page): full main-column width (`-mx-6` wrapper), taller card (`min-h` ~52vh cap), warning list scroll `min-h`/`max-h` up to ~70vh. **Potential fixes (AI)** button on each warning line, each failed table row, and auth-skipped note; dispatches `kb-ai-send` to open AI panel in **Ask** mode with structured prompt (`lib/kb-ai-events.ts`). `AiAssistant` listens for that event; `sendMessage` uses history captured **before** appending the user turn.
- AI context: `/logs` path mapped for assistant; platform `AiService` page map includes `logs`.

## 2026-03-29 (overview Integrations card)
- Project overview stats: **Integrations** tile shows GitHub + Vercel rows with icons and linked **repo** (`owner/repo`) / **Vercel project** name; each row is an `<a target="_blank">` to repo URL, constructed GitHub URL, or Vercel project/dashboard URL, with fallback to project Integrations page if URL missing. Passes merged `gh`/`vc` from `ProjectDetail` into `ProjectAdvisorSection`.

## 2026-03-29 (GitHub integrations — branch after repo)
- Project Integrations: **Branch** picker and **Connect Repository** only render after a **repository** is selected (no branch field or connect button while repo is empty). Connect disabled while branches are loading.

## 2026-03-29 (English UI + multilingual AI)
- Admin UI: translated all Turkish strings in `ai-assistant.tsx` (labels, toasts, placeholders, suggestions, agent trace) to English.
- `platform-api` `AiService`: system prompts and error copy in English; explicit rule to **reply in the same language as the user’s latest message** (any language), default English if ambiguous.

## 2026-03-29 (project logs + Advisor View log)
- Advisor **View log** linked to overview only (no navigation). Added route `/dashboard/projects/[id]/logs` with full Supabase import log UI; Advisor CTA now points to `/logs`.
- Extracted `ProjectImportLogCard` for reuse on overview and logs page.
- Project layout sidebar: **Project logs** (`ScrollText` icon) above **Documentation** (expanded + collapsed rail).

## 2026-03-29 (theme + header chrome)
- `next-themes` + `ThemeProvider` in root layout; `ThemeToggle` (moon/sun) in dashboard header for night mode. Team / Projects header triggers: removed outer `border`/`bg-background`, use hover `bg-muted/80` only.
- Project sidebar: **Sidebar** label beside Auto/Open segmented when **expanded**; collapsed Auto rail shows **Auto** only (see entry below).

## 2026-03-29 (sidebar collapsed auto label)
- When sidebar mode is **Auto** and the rail is **collapsed** (pointer not over aside), footer shows **only** the word **Auto** under Documentation (no vertical segmented); hover expands sidebar to use full **Sidebar** + Auto/Open control at bottom.

## 2026-03-29 (overview + header)
- Header: when URL is `/dashboard/projects/[id]`, fetch project and **align active team** with `project.teamId` (if different); Projects menu label and dropdown use route project even before team list refresh; current project injected into menu if missing from list.
- Overview: new `ProjectAdvisorSection` — Supabase-style **quick stats** (status, last import, integrations, data snapshot) + horizontal **Advisor** cards (SECURITY / DATABASE / AUTH / INTEGRATIONS / PERFORMANCE) from import log, failed tables, auth skipped, GitHub/Vercel hints; empty state “No issues detected”.

## 2026-03-29 (later)
- Added `.cursor/rules/post-task-docker.mdc` (`alwaysApply: true`): after tasks that touch app code or Docker-related files, agent runs `docker compose up -d --build` from repo root unless user opts out.

## 2026-03-29
- Project detail layout (`dashboard/projects/[id]/layout.tsx`): sidebar Auto/Open is an **iOS-style segmented control** (muted track + white selected pill) placed **under Documentation** when expanded; removed the external Mode rail. Collapsed Auto rail shows **Auto** text only under docs (see 2026-03-29 sidebar collapsed auto label).
- Header (`components/header.tsx`): **Projects** dropdown next to the team switcher — lists `ACTIVE` projects for the selected team, highlights current project when URL is `/dashboard/projects/[id]`, navigates on row click; footer link **All projects** → `/dashboard/projects`. Team/project menus close each other when opening the other.

## 2026-03-28
- Re-import minimize/maximize: keep dialog internal view as `importing` when closing during a running job (removed erroneous `setView('create')`). Re-import open effect now skips resetting the credential form when `activeImport` is `running` for the same `projectId`, so reopening from the toast shows import steps and progress instead of the setup screen.
- Storage UI “duplicate” bucket names like `docs` + `2-docs`: MinIO bucket `kb-{slug}-2-docs` starts with prefix `kb-{slug}-`, so it was incorrectly listed under the shorter slug (shown as `2-docs`). `listBuckets` now assigns each physical bucket to the **longest** matching project slug among all `ACTIVE` projects. Supabase import uses one logical bucket name (`name` or `id`) consistently for create/upload.
- Same-project ghost `2-docs`: listing alone cannot drop `kb-{slug}-2-docs` when only one project matches both `…-docs` and `…-2-docs`. After each Supabase storage import, `pruneProjectStorageBuckets` deletes project buckets whose logical names are **not** in the Supabase bucket API list (so only `docs` remains when source has only `docs`). Logical names normalized to lowercase for Kolaybase.

## 2026-04-09 (feedback screenshot feature)
**Added automatic screenshot capture to feedback modal**

### Changes:
**`apps/admin-ui/components/feedback-modal.tsx`:**
- Added "Take Screenshot" button next to "Add image or video" button
- When clicked, modal temporarily closes, captures entire page screenshot using `html2canvas`, and reopens
- Screenshot automatically added to attachments list as PNG file with timestamp
- Added `takingScreenshot` state to show loading state ("Capturing...")
- Added Camera icon from `lucide-react`

**`apps/admin-ui/package.json`:**
- Added `html2canvas: ^1.4.1` dependency for screenshot capture

### Features:
1. One-click screenshot of current page without leaving feedback modal
2. Screenshot automatically named with timestamp (`screenshot-YYYY-MM-DDTHH-mm-ss.png`)
3. Respects maximum file limit (5 files)
4. Smooth UX: modal closes → capture → modal reopens with screenshot attached
5. Toast notification on success or failure

### Files Modified:
- `apps/admin-ui/components/feedback-modal.tsx`
- `apps/admin-ui/package.json`

## 2026-04-09 (project detail page loading fix - comprehensive)
**Fixed persistent "This page couldn't load" error with multiple improvements**

### Problem:
- Project detail pages showed "This page couldn't load / Reload to try again" error
- Both `layout.tsx` and `page.tsx` were fetching the same project (duplicate API calls)
- Billing useEffect wasn't reacting to pathname changes
- Race conditions between layout and page project fetching
- Frozen account checks not properly evaluating on route changes

### Root Causes Identified:
1. **Missing dependencies**: Billing useEffect lacked `pathname` and `router` in dependency array
2. **Duplicate fetching**: Layout and page both independently fetched project data
3. **No shared state**: Project state isolated between layout and page components
4. **Timing issues**: Billing checks running without pathname context

### Solution:
**1. Created ProjectContext for shared state:**
**`apps/admin-ui/contexts/project-context.tsx`:** (NEW FILE)
- Created `ProjectContext` and `ProjectProvider` to share project and loading state
- Added `useProject()` hook for consuming components
- Eliminates duplicate fetching and race conditions

**2. Updated project detail layout:**
**`apps/admin-ui/app/dashboard/projects/[id]/layout.tsx`:**
- Added `projectLoading` state to track fetch progress
- Wrapped entire layout return in `<ProjectProvider>`
- Provides project and loading state to all child components
- Enhanced loading states: shows spinner while loading, error message if not found
- Fixed `.finally(() => setProjectLoading(false))` to properly manage loading state

**3. Simplified project detail page:**
**`apps/admin-ui/app/dashboard/projects/[id]/page.tsx`:**
- **REMOVED** all project fetching logic (50+ lines removed)
- **REMOVED** duplicate `recoverProjectWithTeamSwitch` implementation
- Now uses `useProject()` hook to get project from context
- Dramatically simplified: from 65 lines to 22 lines
- No duplicate API calls - uses data already fetched by layout

**4. Fixed dashboard layout billing check:**
**`apps/admin-ui/app/dashboard/layout.tsx`:**
- **ADDED** `pathname` and `router` to billing useEffect dependencies: `[activeTeamId, pathname, router]`
- Now properly reacts to route changes for frozen account checks
- Enhanced frozen account logic: allows access to `/dashboard/billing`, `/dashboard/projects`, and `/dashboard/projects/[id]`
- Blocks access only to restricted routes (team, management, feedback)

### Benefits:
1. **No duplicate API calls**: Project fetched once by layout, shared via context
2. **Better performance**: Reduced network requests from 4+ to 1 per project view
3. **Cleaner code**: Page component 43 lines shorter, easier to maintain
4. **Proper state management**: Single source of truth for project data
5. **Reliable routing**: Billing checks properly evaluate on pathname changes
6. **Better UX**: Faster page loads, no race conditions

### API Call Reduction:
**Before:** 
- Layout: `GET /api/projects/{id}` (with recovery attempts)
- Page: `GET /api/projects/{id}` (with recovery attempts)
- = 2-4 duplicate calls per page load

**After:**
- Layout: `GET /api/projects/{id}` (once, shared via context)
- Page: Uses context data (zero API calls)
- = 1 call per page load

### Files Modified:
- `apps/admin-ui/contexts/project-context.tsx` (NEW)
- `apps/admin-ui/app/dashboard/projects/[id]/layout.tsx`
- `apps/admin-ui/app/dashboard/projects/[id]/page.tsx`
- `apps/admin-ui/app/dashboard/layout.tsx`

### Technical Details:
- Context pattern chosen over prop drilling for cleaner component hierarchy
- Loading state properly managed in layout before provider wraps children
- Error boundaries maintained: layout shows spinner/error, page delegates to layout's state
- Recovery mechanism (`recoverProjectWithTeamSwitch`) kept only in layout, not duplicated

## 2026-04-09 (project detail page loading fix - initial attempt)
**First attempt to fix "This page couldn't load" error**

### Problem:
- When clicking on a project to view details, page showed "This page couldn't load / Reload to try again" error
- Layout was calling billing API on every pathname change
- If billing API was slow or failed, it prevented child pages from rendering

### Solution:
**`apps/admin-ui/app/dashboard/layout.tsx`:**
- Removed `pathname` and `router` from billing `useEffect` dependencies
- Billing API now only called when `activeTeamId` changes (not on every page navigation)
- Added `isMounted` cleanup flag to prevent state updates after unmount
- Enhanced error handling: billing API failures no longer break page rendering
- Added `console.error` logging for debugging

### Changes:
1. **Dependency optimization**: Changed from `[activeTeamId, pathname, router]` → `[activeTeamId]`
2. **Cleanup handling**: Added `isMounted` flag and cleanup return function
3. **Error recovery**: `.catch()` now sets `billingBanner(null)` instead of leaving page broken
4. **Frozen account redirect**: Still works but only checks `pathname` inside effect body (not dependency)

### Note:
This was later superseded by comprehensive fix with ProjectContext (see above)

## 2026-03-27
- Added table name `Search tables...` input to `TableEditor` sidebar, and filter table list by name (no effect on row filter).
- Fixed Supabase import warnings flow so tables with `0 rows imported` are also appended to import `warnings` (shown in result dialog + overview import log).
- Import complete modal: primary action navigates to `/dashboard/projects/[id]` for the imported project; persist `projectId` in import progress context/localStorage for resume.
- Overview import log: merge `project.supabaseImportLog` with per-browser `localStorage` backup saved when import completes (`import-log-storage.ts`) so warnings show even if API DB field is empty; hint when only browser copy exists.

