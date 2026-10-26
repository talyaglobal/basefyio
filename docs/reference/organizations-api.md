# Organizations API (`/api/organizations`)

Every account belongs to at least one **organization**: the personal one created at sign-up
(`<Your name>'s Organization`) and any number of further ones for a company, a team, a client.
Projects, members, roles, the plan and the invoices all belong to an organization.

An organization is addressed by its **public id**: twenty lowercase characters
(`bbjhvprglckpgrhazpvx`-shaped), random, stable for the life of the organization and carrying
nothing about its name or owner. The `/api/teams/*` routes keep working unchanged with the
same objects under their internal name, so an SDK or CLI built against them needs no change;
every `/api/teams` object now also carries `publicId`, `kind` and `plan`.

## Authentication

A dashboard session (Keycloak JWT). Every route checks membership; writes check the caller's
role permissions exactly as the `/api/teams` routes do.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/organizations` | the caller's organizations: `id`, `organizationId`, `publicId`, `name`, `slug`, `kind`, `isPersonal`, `role`, `plan { name, displayName }`, `memberCount`, `projectCount`, `projects { awake, deactivated }`, `requireMfa` |
| GET | `/api/organizations/kinds` | the kinds an organization can be given: `COMPANY`, `STARTUP`, `AGENCY`, `EDUCATION`, `NONPROFIT`, `OPEN_SOURCE`, `OTHER` (`PERSONAL` is reserved for the one made at sign-up) |
| POST | `/api/organizations` | `{ name, kind?, planName?, successUrl?, cancelUrl? }` — see below |
| GET | `/api/organizations/:id` | overview: the fields above plus `description`, `websiteUrl`, `logoUrl`, `counts { members, projects, projectsAwake, projectsDeactivated, pendingInvites }` and `usage` |
| PATCH | `/api/organizations/:id` | `{ name?, kind?, description?, websiteUrl?, logoUrl? }` — needs `canRenameTeam`; a personal organization keeps its kind |
| POST | `/api/organizations/:id/switch` | make it the caller's active organization (same as `PUT /api/teams/active`) |
| GET | `/api/organizations/:id/projects` | its projects that are not in the trash, with `status` |
| GET | `/api/organizations/:id/members` | members and roles |
| GET | `/api/organizations/:id/invites` | pending invites |
| GET | `/api/organizations/:id/billing` | the subscription view of `GET /api/billing/subscription`, addressed by public id |

`:id` accepts the public id or, for links that predate it, the organization's uuid.

### Creating one

`POST /api/organizations` with `{ "name": "Acme", "kind": "COMPANY" }` creates the organization on
the free plan and returns `{ organization, checkoutRequired: null, checkoutUrl: null }`. The caller
becomes its OWNER, the default role permissions are seeded, and the slug is derived from the name
(a short suffix is added when another organization already uses it).

With a paid `planName` the organization is still created on the free plan; the response carries
`checkoutRequired: { planName }` and, when `successUrl` and `cancelUrl` were given, a Stripe
`checkoutUrl` to send the browser to. The plan is applied by the Stripe webhook once the payment
succeeds, never before.

`name` is 2–60 characters; `kind` must be one of `GET /api/organizations/kinds`; `planName` must be a
public plan.

## Feature flag

The organization pages in the dashboard (the overview under `/dashboard/org/<id>`, the creation
wizard and the header switcher) are switched on per installation with the runtime flag
`organizations_ui`. The API routes above are always on.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/features` | public — every flag and whether it is on, e.g. `{ "organizations_ui": false }` |
| PATCH | `/api/features/management` | root console — `{ name, enabled }` flips one flag; it is visible everywhere within 30 seconds, no deploy |

A flag is a `system_settings` row `features.<name>` holding a boolean; a missing row means off.
The root console flips it under Users & billing → Organizations.

With `organizations_ui` on, the dashboard gains `/dashboard/org/<id>` (overview), `/projects`,
`/members`, `/billing`, `/settings` and the creation wizard at `/dashboard/org/new`; the header
switcher says "Organization", shows each organization's kind and plan, and offers "Create
organization"; the old `/dashboard/team` and `/dashboard/billing` addresses forward to the active
organization's pages (Stripe's return to `/dashboard/billing?success=true` included). Opening an
organization's address makes it the active one, as opening a project does. With the flag off the
dashboard is exactly as before.

## Role permissions

The per-role flags an owner edits under Organization → Roles (`GET/PUT /api/teams/:id/role-permissions`)
are `canRenameTeam`, `canInviteMembers`, `canRemoveMembers`, `canManageIntegrations`,
`canCreateProjects`, `canDeleteProjects`, `canRestoreProjects`, `canMoveProjects`,
`canResetDbPassword`, `canViewBilling` and `canManageBilling`. An OWNER always has all of them.
Where an organization has no row for a role, the defaults apply: an ADMIN has everything except
`canResetDbPassword` and `canManageBilling`; a MEMBER has `canCreateProjects` only.

How far the project and billing flags reach is set by the operator with
[`ORG_PERMISSIONS_ENFORCED`](./configuration.md): `log` (the default) lets the flags grant what they
promise and only logs where they would deny; `enforce` also denies. Activating a deactivated
project is never gated beyond membership.
