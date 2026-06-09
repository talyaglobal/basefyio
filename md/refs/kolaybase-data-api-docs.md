# KolayBase — Supabase Data API (PostgREST) Documentation & Frontend Prompt

> Auto-generated reference for the **kolaylinks** project Data API.
> Project ref: `cgefrooedjttzhhyungc`
> Generated: 2026-05-31

---

## 1. Where to find the Data API in Supabase

Supabase Dashboard → left sidebar → **Integrations** → **Data API**.

The Data API screen has three tabs:

| Tab | Purpose |
|-----|---------|
| **Overview** | API URL + project keys (`anon`, `service_role`). |
| **Settings** | PostgREST config: exposed schemas, extra search path, max rows. |
| **Docs** | Auto-generated, per-table CRUD reference (the source of this file). |

PostgREST configuration itself lives under **Project Settings → API** (Exposed schemas, Extra search path, Max rows).

---

## 2. Connecting to the API

```js
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://cgefrooedjttzhhyungc.supabase.co'
const supabaseKey = process.env.SUPABASE_ANON_KEY // never hard-code keys
const supabase = createClient(supabaseUrl, supabaseKey)
```

REST base endpoint: `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/`
Required headers: `apikey: <ANON_KEY>` and `Authorization: Bearer <ACCESS_TOKEN>`.

---

## 3. CRUD cheat-sheet (PostgREST patterns)

### SELECT (read / view)
```js
// all rows + all columns
const { data, error } = await supabase.from('TABLE').select('*')

// specific columns
const { data } = await supabase.from('TABLE').select('col_a, col_b')

// filtering
const { data } = await supabase.from('TABLE').select('*').eq('is_active', true)

// ordering + pagination
const { data } = await supabase
  .from('TABLE')
  .select('*')
  .order('created_at', { ascending: false })
  .range(0, 9) // first 10 rows

// referenced (joined) tables
const { data } = await supabase.from('links').select('*, profiles(*)')
```

REST: `GET /rest/v1/TABLE?select=*&is_active=eq.true&order=created_at.desc`

### INSERT
```js
const { data, error } = await supabase
  .from('TABLE')
  .insert([{ col_a: 'value', col_b: 123 }])
  .select()
```
REST: `POST /rest/v1/TABLE` with JSON body.

### UPDATE
```js
const { data, error } = await supabase
  .from('TABLE')
  .update({ col_a: 'new value' })
  .eq('id', someId)
  .select()
```
REST: `PATCH /rest/v1/TABLE?id=eq.<id>`

### UPSERT
```js
const { data, error } = await supabase
  .from('TABLE')
  .upsert({ id: someId, col_a: 'value' })
  .select()
```

### DELETE
```js
const { error } = await supabase
  .from('TABLE')
  .delete()
  .eq('id', someId)
```
REST: `DELETE /rest/v1/TABLE?id=eq.<id>`

### Common filters
`eq, neq, gt, gte, lt, lte, like, ilike, is, in, contains, containedBy, range*`, plus `.or()`, `.not()`, `.match()`.

---

## 4. Tables & Views (full list — endpoints)

Each table is exposed at `/rest/v1/<table>` and supports `select / insert / update / delete`
via `supabase.from('<table>')`.

| Table | REST endpoint |
|-------|---------------|
| `admin_actions` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/admin_actions` |
| `admin_badges` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/admin_badges` |
| `admin_notification_settings` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/admin_notification_settings` |
| `admin_notifications` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/admin_notifications` |
| `admin_reports` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/admin_reports` |
| `admin_stats` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/admin_stats` |
| `api_keys` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/api_keys` |
| `blocked_ips` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/blocked_ips` |
| `browser_analytics` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/browser_analytics` |
| `careers` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/careers` |
| `contact_messages` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/contact_messages` |
| `custom_domain_settings` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/custom_domain_settings` |
| `custom_domain_verifications` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/custom_domain_verifications` |
| `custom_domains` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/custom_domains` |
| `daily_active_users` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/daily_active_users` |
| `device_analytics` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/device_analytics` |
| `email_subscribers` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/email_subscribers` |
| `enterprise_plans` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/enterprise_plans` |
| `error_logs` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/error_logs` |
| `feature_definitions` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/feature_definitions` |
| `feature_usage` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/feature_usage` |
| `feature_usage_events` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/feature_usage_events` |
| `geographic_analytics` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/geographic_analytics` |
| `link_clicks` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/link_clicks` |
| `link_previews` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/link_previews` |
| `link_share_stats` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/link_share_stats` |
| `links` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/links` |
| `media` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/media` |
| `monthly_usage` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/monthly_usage` |
| `overage_charges` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/overage_charges` |
| `page_links` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/page_links` |
| `page_social_links` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/page_social_links` |
| `performance_metrics` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/performance_metrics` |
| `profile_theme_stats` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/profile_theme_stats` |
| `profile_views` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/profile_views` |
| `profiles` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/profiles` |
| `public_pages` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/public_pages` |
| `quota_changes` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/quota_changes` |
| `quota_definitions` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/quota_definitions` |
| `security_logs` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/security_logs` |
| `social_links` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/social_links` |
| `social_shares` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/social_shares` |
| `subscription_events` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/subscription_events` |
| `subscription_plans` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/subscription_plans` |
| `team_activity_logs` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/team_activity_logs` |
| `team_invitations` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/team_invitations` |
| `team_members` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/team_members` |
| `teams` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/teams` |
| `theme_presets` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/theme_presets` |
| `usage_alerts` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/usage_alerts` |
| `user_feature_access` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/user_feature_access` |
| `user_signups` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/user_signups` |
| `user_subscriptions` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/user_subscriptions` |
| `utm_campaign_analytics` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/utm_campaign_analytics` |
| `webhook_deliveries` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/webhook_deliveries` |
| `webhooks` | `https://cgefrooedjttzhhyungc.supabase.co/rest/v1/webhooks` |

> **Example — `links` table columns**
>
> | Column | Required | Type | Format |
> |--------|----------|------|--------|
> | id | required | string | uuid |
> | profile_id | required | string | uuid |
> | title | required | string | text |
> | url | optional | string | text |
> | order_no | required | number | integer |
> | is_active | required | boolean | boolean |
> | created_at | optional | string | timestamptz |
> | updated_at | optional | string | timestamptz |
> | scheduled_start | optional | string | timestamptz |
> | scheduled_end | optional | string | timestamptz |
> | is_scheduled | optional | boolean | boolean |
> | expires_at | optional | string | timestamptz |
>
> Open the Data API → Docs page and select any table to see its exact column list and generated code, following the same shape.

---

## 5. Stored Functions (RPC)

Call via `supabase.rpc('<function>', { ...args })` → REST `POST /rest/v1/rpc/<function>`.

```js
const { data, error } = await supabase.rpc('get_profile_by_username', { username: 'alice' })
```

| Function (RPC) |
|----------------|
| `activate_theme_preset` |
| `award_admin_points` |
| `calculate_level` |
| `calculate_monthly_overages` |
| `can_create_page` |
| `can_create_profile` |
| `check_feature_access` |
| `cleanup_expired_domain_verifications` |
| `create_default_theme_presets` |
| `decrement_team_member_count` |
| `generate_link_preview` |
| `generate_verification_token` |
| `get_advanced_stats` |
| `get_all_user_feature_access` |
| `get_canonical_url` |
| `get_current_month_usage` |
| `get_daily_active_users` |
| `get_daily_signups` |
| `get_effective_quota` |
| `get_feature_adoption` |
| `get_max_pages_for_plan` |
| `get_max_profiles` |
| `get_profile_by_username` |
| `get_profile_stats` |
| `get_profile_theme_presets` |
| `hide_ended_scheduled_links` |
| `hide_expired_links` |
| `increment_team_member_count` |
| `is_admin` |
| `is_enterprise_user` |
| `is_username_available` |
| `log_feature_usage` |
| `record_daily_active_user` |
| `record_feature_usage` |
| `record_link_click` |
| `record_profile_view` |
| `record_user_signup` |
| `track_social_share` |
| `unhide_scheduled_links` |
| `update_admin_streak` |
| `update_user_feature_access` |
| `validate_custom_domain` |

GraphQL endpoint is also available via the **GraphiQL** explorer in the same Docs menu.

---

## 6. Frontend prompt for KolayBase (paste into your AI builder)

```text
You are building the KolayBase admin frontend on top of a Supabase (PostgREST) backend
for the "kolaylinks" project. Build a data-management UI with the following:

CONNECTION
- Use @supabase/supabase-js. Read URL + anon key from env vars. Never hard-code keys.

NAVIGATION (left sidebar menu)
- Group resources into sections: "Admin", "Links & Pages", "Profiles & Social",
  "Analytics", "Billing & Plans", "Teams", "System".
- Each table from the list below is a sidebar menu item that opens a data view.

PER-TABLE DATA VIEW (generic, reusable component)
- A searchable, paginated DATA TABLE (server-side: .range() + .order()).
- Column headers sortable (toggle .order ascending/descending).
- A "Columns" DROPDOWN to choose which columns to .select().
- A FILTER bar with a DROPDOWN to pick column + operator (eq, ilike, gt, lt, in, is)
  and a value input, applied to the query.
- Row actions: VIEW (modal showing full record), EDIT, DELETE (with confirm dialog).
- Toolbar buttons: INSERT (opens a form), REFRESH, EXPORT.

CRUD WIRING
- SELECT/VIEW: supabase.from(table).select(cols).order().range()
- INSERT: form generated from the column metadata (required vs optional, type/format);
  submit with .insert([row]).select()
- UPDATE: pre-filled edit form; submit with .update(row).eq('id', id).select()
- DELETE: .delete().eq('id', id) behind a confirmation modal.
- For UUID columns use text inputs; integers -> number inputs; booleans -> toggles;
  timestamptz -> datetime pickers.

RPC PANEL
- A "Functions" page listing all RPC functions in a DROPDOWN; selecting one renders
  an argument form and calls supabase.rpc(name, args), showing the JSON result.

UX
- Toast notifications on success/error (surface error.message).
- Optimistic UI optional; always re-fetch after mutations.
- Respect RLS: handle 401/403 gracefully and show a friendly message.

Tables: [INSERT THE TABLE LIST BELOW]
RPC functions: [INSERT THE RPC LIST BELOW]
```

---

## 7. Appendix — raw lists

**Tables (56):**

admin_actions, admin_badges, admin_notification_settings, admin_notifications, admin_reports, admin_stats, api_keys, blocked_ips, browser_analytics, careers, contact_messages, custom_domain_settings, custom_domain_verifications, custom_domains, daily_active_users, device_analytics, email_subscribers, enterprise_plans, error_logs, feature_definitions, feature_usage, feature_usage_events, geographic_analytics, link_clicks, link_previews, link_share_stats, links, media, monthly_usage, overage_charges, page_links, page_social_links, performance_metrics, profile_theme_stats, profile_views, profiles, public_pages, quota_changes, quota_definitions, security_logs, social_links, social_shares, subscription_events, subscription_plans, team_activity_logs, team_invitations, team_members, teams, theme_presets, usage_alerts, user_feature_access, user_signups, user_subscriptions, utm_campaign_analytics, webhook_deliveries, webhooks

**RPC functions (42):**

activate_theme_preset, award_admin_points, calculate_level, calculate_monthly_overages, can_create_page, can_create_profile, check_feature_access, cleanup_expired_domain_verifications, create_default_theme_presets, decrement_team_member_count, generate_link_preview, generate_verification_token, get_advanced_stats, get_all_user_feature_access, get_canonical_url, get_current_month_usage, get_daily_active_users, get_daily_signups, get_effective_quota, get_feature_adoption, get_max_pages_for_plan, get_max_profiles, get_profile_by_username, get_profile_stats, get_profile_theme_presets, hide_ended_scheduled_links, hide_expired_links, increment_team_member_count, is_admin, is_enterprise_user, is_username_available, log_feature_usage, record_daily_active_user, record_feature_usage, record_link_click, record_profile_view, record_user_signup, track_social_share, unhide_scheduled_links, update_admin_streak, update_user_feature_access, validate_custom_domain
