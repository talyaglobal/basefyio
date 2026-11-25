# Extra database roles

An extra database role is a Postgres role that belongs to one project. Give each service its own
role instead of sharing the owner's password: the API server, a worker, a migration job. You can
then limit what each one can do, rotate its password on its own, and remove it without touching
the others.

There are two kinds:

- **login** roles connect with their own password. They are `LOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOBYPASSRLS`; these attributes are fixed and cannot be changed.
- **group** roles are `NOLOGIN`. They own functions and tables and receive grants. The project
  owner is a member `WITH INHERIT FALSE, SET TRUE`, so the owner can `SET ROLE` to a group but
  never uses its rights by accident. Login roles can join a group.

A project has at most 10 login roles and 10 group roles. Every role can connect to the project's
own database only. Each create, change, password rotation and removal is written to the
project's activity log with the person, the role name and the action, never the password.

## Name your roles: the role prefix

Without a prefix, roles get generated names such as `kb_xr_1a2b3c4d5e`. To use readable names,
choose a prefix for the project once:

```http
PUT /api/projects/:id/db-role-prefix
{ "prefix": "myapp" }
```

- 3 to 20 characters: a lower-case letter, then lower-case letters or digits.
- Reserved values are refused, and so is a prefix that another project uses or that matches an
  existing database role.
- You can change the prefix until the first role uses it. After that it is fixed.

Then create roles with a `name`. Each role is called `<prefix>_<name>`:

```http
POST /api/projects/:id/db-extra-roles
{ "label": "Schema owner", "kind": "group", "name": "owner" }

POST /api/projects/:id/db-extra-roles
{ "label": "API server", "name": "app", "memberOf": ["myapp_owner"] }
```

- `name`: 2 to 31 characters, a lower-case letter, then lower-case letters, digits or `_`.
- If the name already exists as a database role anywhere on the server, the answer is 409 and
  nothing is changed.
- A named role can only be a member of this project's own group roles.

The `POST` answer holds the password of a login role. It is shown only once: store it now. The
list (`GET /api/projects/:id/db-extra-roles`) never returns passwords. To read one again, use
the dashboard (Connect, Reveal). To issue a new one, rotate it with
`PATCH /api/projects/:id/db-extra-roles/:roleId/password`.

The same actions are available in the dashboard (Connect, Extra database users), in the CLI
(`basefyio db roles create|list|reset-password|drop`) and as MCP tools (`create_db_role`,
`list_db_roles`, `reset_db_role_password`, `drop_db_role`). They need the `secrets:write`
scope (`secrets:read` to list).

## Connect through the pooler

Connect with the role's name and password on the pooler port, as you do with the owner:

```
postgresql://myapp_app:<password>@<pooler host>:6432/<database>?sslmode=require
```

The pooler runs in **transaction mode**. Each transaction can run on a different server
connection, so session state does not survive between transactions. A plain `SET ROLE` at
session level is lost after the next transaction. Change roles with `SET LOCAL ROLE` inside the
transaction that needs it:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT * FROM orders;
COMMIT;
```

## Run migrations as the group role

When objects must belong to the group role (for example `myapp_owner`), run the whole migration
in one transaction and change to the group role at the start:

```sql
BEGIN;
SET LOCAL ROLE myapp_owner;
CREATE TABLE app_private.audit (id bigserial PRIMARY KEY, at timestamptz DEFAULT now());
-- more statements
COMMIT;
```

`SET LOCAL ROLE` ends with the transaction, so the next transaction starts again as the role you
connected with.

See [project-admin-api.md](../reference/project-admin-api.md#extra-database-roles) for every
field, answer and limit.
