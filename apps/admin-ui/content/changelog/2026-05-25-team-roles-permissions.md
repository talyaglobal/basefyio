---
date: 2026-05-25
slug: team-roles-permissions
title: Team Roles & Granular Permission Control
kind: feature
version: v1.2.0
summary: Teams now have three roles — Owner, Admin, and Member — with a fully customizable permission matrix. Each team owner can configure exactly what Admins and Members are allowed to do.
---

Managing a team used to be all-or-nothing. You were either the Owner with full control, or a Member who could do almost everything but manage the team itself. That created a real problem: you couldn't delegate responsibilities without giving away too much access.

Today that changes.

## What's new?

### Three roles instead of two

Every team now has three distinct roles:

- **Owner** — Full control. The only one who can delete the team, transfer ownership, or change role permissions.
- **Admin** — A trusted member who can manage day-to-day operations: invite people, connect integrations, create and delete projects.
- **Member** — Can work within projects but doesn't have administrative access by default.

To change a member's role, click the role dropdown next to their name in Team Settings.

---

### Per-team permission matrix

This is the real power. Every team Owner gets a **Role Permissions** panel in Team Settings — a table where you can toggle exactly what each role is allowed to do.

Permissions are grouped into three categories:

**Team Settings**
- Rename team
- Invite & re-invite members
- Remove members
- Manage integrations (GitHub, Vercel)

**Projects**
- Create projects
- Delete projects
- Restore deleted projects
- Move projects between teams

**Billing**
- View billing & invoices
- Manage plans & payments

Each permission can be toggled independently for Admin and Member roles. Owner always has full access — that column is locked.

After making changes, hit **Save Changes** at the bottom right. Nothing is saved until you explicitly confirm.

---

### Sensible defaults

When you create a new team or upgrade to this version, the defaults are:

| Permission | Admin | Member |
|---|---|---|
| Rename team | ✓ | — |
| Invite members | ✓ | — |
| Remove members | ✓ | — |
| Manage integrations | ✓ | — |
| Create projects | ✓ | ✓ |
| Delete projects | ✓ | — |
| Restore projects | ✓ | — |
| Move projects | ✓ | — |
| View billing | ✓ | — |
| Manage billing | — | — |

These are just defaults. Every team Owner can adjust them to fit their workflow.

---

### What this enables

A few real scenarios this unlocks:

- **Freelancer with clients**: Make your client a Member with only "Create projects" enabled. They can create projects but can't touch billing or integrations.
- **Agency with developers**: Promote senior developers to Admin so they can invite team members and manage integrations, while you keep billing control to yourself.
- **Open team**: Enable all permissions for Members if you trust everyone equally — the system doesn't force hierarchy on you.

---

### Integration access control

Previously, any team member could connect or disconnect GitHub and Vercel integrations. That led to situations where someone accidentally disconnected a shared integration.

Now, integration management respects the permission matrix. Only users with the "Manage integrations" permission can connect or disconnect. Everyone else can still *use* the connected integrations — they just can't change them.

---

## Technical notes

- Permissions are stored per-team in the database, not globally. Each team has its own configuration.
- The permission check happens on both the backend (API rejects unauthorized requests) and frontend (buttons are hidden for users without access).
- Existing teams automatically receive default permission rows during the database migration — no manual setup needed.
- The Owner role is hardcoded to have all permissions and cannot be restricted.
