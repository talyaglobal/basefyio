import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ALL_SCOPES } from '../api-tokens/api-tokens.constants';
import type { TeamsService } from '../teams/teams.service';
import type { ProjectsService } from '../projects/projects.service';
import type { ProjectDataService } from '../projects/project-data.service';
import type { SqlService } from '../sql/sql.service';
import type { StorageService } from '../storage/storage.service';
import type { S3KeysService } from '../storage/s3-keys.service';
import type { KeycloakAdminService } from '../auth/keycloak-admin.service';
import {
  ProjectActivityKind,
  type ProjectActivityService,
} from '../projects/project-activity.service';

/**
 * The MCP tool catalogue.
 *
 * Every tool declares the one scope a token must hold to see it in tools/list
 * and to call it. McpService checks that scope again on every call, and checks
 * tenancy centrally before `run`: a `projectId` argument must name a project
 * whose team the token's owner belongs to (and the token's team, when it is
 * team-restricted); a `teamId` argument likewise. A tool therefore cannot reach
 * a project by any other argument name — `assertToolCatalogue` refuses one.
 *
 * Each tool calls an existing service with the token owner's user id, so the
 * service's own membership check runs as well. No tool returns a secret (no
 * database password, project key or connection string) with these exceptions,
 * each under `secrets:write` and only in that one answer, as the dashboard does:
 * create_s3_key returns the new key's secret, create_db_role and
 * reset_db_role_password the role's password. The audit row never stores
 * arguments or results.
 */

export interface McpDeps {
  teams: TeamsService;
  projects: ProjectsService;
  data: ProjectDataService;
  sql: SqlService;
  storage: StorageService;
  keycloak: KeycloakAdminService;
  activity: ProjectActivityService;
  s3Keys: S3KeysService;
}

export interface McpCaller {
  /** The token owner. Never empty: McpService refuses a token without one. */
  userId: string;
  /** Set when the token is restricted to one team. */
  teamId: string | null;
  tokenId: string;
  deps: McpDeps;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  scope: string;
  description: string;
  input: z.ZodRawShape;
  annotations: ToolAnnotations;
  run: (args: Record<string, any>, caller: McpCaller) => Promise<unknown>;
}

/**
 * Refuse a catalogue entry that could skip a check: no scope or an unknown
 * one, or a project/team reference under any name other than the two the
 * tenancy check reads. Runs when the module loads, so a bad entry stops boot.
 */
export function assertToolCatalogue(tools: McpToolDefinition[]): void {
  const names = new Set<string>();
  for (const t of tools) {
    if (!t.name || names.has(t.name)) throw new Error(`MCP tool "${t.name}": missing or duplicate name`);
    names.add(t.name);
    if (!t.scope || !ALL_SCOPES.has(t.scope)) {
      throw new Error(`MCP tool "${t.name}": declares no known scope ("${t.scope ?? ''}")`);
    }
    for (const key of Object.keys(t.input)) {
      if (/project|team/i.test(key) && key !== 'projectId' && key !== 'teamId') {
        throw new Error(`MCP tool "${t.name}": "${key}" would bypass the tenancy check`);
      }
    }
    if (t.input.projectId?.isOptional()) {
      throw new Error(`MCP tool "${t.name}": projectId must be required`);
    }
  }
}

/** The tools a token holding `scopes` may see and call. */
export function toolsForScopes(scopes: readonly string[]): McpToolDefinition[] {
  const held = new Set(scopes);
  return MCP_TOOLS.filter((t) => held.has(t.scope));
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const projectId = z.string().uuid().describe('Project id (a UUID), as returned by list_projects.');
const table = z.string().min(1).max(63).describe('Table name without the schema, e.g. "orders".');
const schema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(63)
  .optional()
  .describe('Postgres schema of the table. Only needed when the table name exists in more than one schema.');
const rowValues = z
  .record(z.unknown())
  .refine((v) => Object.keys(v).length > 0, 'give at least one column');
const page = z.number().int().min(1).optional().describe('Page number, starting at 1. Default 1.');
const sqlInput = {
  projectId,
  query: z.string().min(1).max(100_000).describe('The SQL. Use $1, $2, ... placeholders for values.'),
  params: z.array(z.unknown()).max(1000).optional().describe('Values for $1, $2, ... in order.'),
  limit: z.number().int().min(1).max(200).optional().describe('Rows per page of a SELECT, 1-200. Default 100.'),
  page,
};

/** The SQL answer without its duplicate per-statement copy unless there were several statements. */
function sqlResult(r: Awaited<ReturnType<SqlService['execute']>>) {
  const { rows, fields, rowCount, page: p, limit, paginated, resultSets } = r;
  return { rows, fields, rowCount, page: p, limit, paginated, ...(resultSets.length > 1 ? { resultSets } : {}) };
}

const MAX_OBJECTS = 1000;

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_teams',
    title: 'List teams',
    scope: 'team:read',
    description:
      'List the teams you belong to, with your role and project count. A team-restricted token sees only its team.',
    input: {},
    annotations: READ,
    run: async (_args, c) => {
      const teams = await c.deps.teams.findAllForUser(c.userId);
      return teams
        .filter((t) => !c.teamId || t.id === c.teamId)
        .map((t) => ({ id: t.id, name: t.name, slug: t.slug, role: t.role, projectCount: t.projectCount }));
    },
  },
  {
    name: 'list_projects',
    title: 'List projects',
    scope: 'projects:read',
    description:
      "List active projects: id, name, slug, status, database type, team and creation time. Pass teamId for one team; without it every team the token can reach is listed.",
    input: { teamId: z.string().min(1).optional().describe('Team id from list_teams.') },
    annotations: READ,
    run: async (args, c) => {
      const teamIds: string[] = args.teamId
        ? [args.teamId]
        : c.teamId
          ? [c.teamId]
          : (await c.deps.teams.findAllForUser(c.userId)).map((t) => t.id);
      const out: unknown[] = [];
      for (const teamId of teamIds) {
        for (const p of await c.deps.projects.findAll(teamId, c.userId)) {
          out.push({
            id: p.id,
            name: p.name,
            slug: p.slug,
            description: p.description,
            status: p.status,
            databaseType: p.databaseType,
            teamId,
            createdAt: p.createdAt,
          });
        }
      }
      return out;
    },
  },
  {
    name: 'get_project',
    title: 'Get a project',
    scope: 'projects:read',
    description:
      "Get one project's details: name, status, database type and name, folder, tags, preview-branch and integration state. Keys and passwords are never returned.",
    input: { projectId },
    annotations: READ,
    run: async (args, c) => {
      const p: any = await c.deps.projects.findOne(args.projectId, c.userId);
      // An allowlist: findOne no longer carries credentials (#14), and new fields stay opt-in.
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        status: p.status,
        databaseType: p.databaseType,
        dbName: p.dbName,
        teamId: p.teamId,
        folder: p.folder,
        tags: p.tags,
        previewBranch: p.previewBranch,
        github: p.github?.connected ? { connected: true, repo: p.github.repoUrl, branch: p.github.branch } : { connected: false },
        vercel: { connected: !!p.vercel?.connected },
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    },
  },
  {
    name: 'list_tables',
    title: 'List tables',
    scope: 'schema:read',
    description: "List the tables in a project's PostgreSQL database: name, schema and row count. System schemas are left out.",
    input: { projectId },
    annotations: READ,
    run: (args, c) => c.deps.data.listTables(args.projectId, c.userId),
  },
  {
    name: 'describe_table',
    title: 'Describe a table',
    scope: 'schema:read',
    description:
      'Describe a table: its columns (name, type, nullable, default, primary key) and its foreign keys. Use it before select_rows or a write so names and types match.',
    input: { projectId, table, schema },
    annotations: READ,
    run: async (args, c) => {
      const [columns, foreignKeys] = await Promise.all([
        c.deps.data.getColumns(args.projectId, c.userId, args.table, args.schema),
        c.deps.data.getForeignKeys(args.projectId, c.userId, args.table),
      ]);
      return { table: args.table, columns, foreignKeys };
    },
  },
  {
    name: 'select_rows',
    title: 'Read rows',
    scope: 'data:read',
    description:
      "Read rows from a table, one page at a time. `search` keeps rows where any column contains the text. Each row carries `_bf_ctid`, which update_rows and delete_row accept to target that exact row. Reads with the project owner's rights, so row-level security does not hide rows.",
    input: {
      projectId,
      table,
      schema,
      limit: z.number().int().min(1).max(200).optional().describe('Rows per page, 1-200. Default 50.'),
      page,
      search: z.string().max(200).optional().describe('Free text to look for in the row values.'),
      orderBy: z.string().max(63).optional().describe('Column to sort by.'),
      orderDir: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default asc.'),
    },
    annotations: READ,
    run: (args, c) =>
      c.deps.data.getRows(
        args.projectId,
        c.userId,
        args.table,
        args.page ?? 1,
        args.limit ?? 50,
        args.schema,
        args.search,
        args.orderBy,
        args.orderDir,
      ),
  },
  {
    name: 'insert_row',
    title: 'Insert a row',
    scope: 'data:write',
    description:
      "Insert one row and return it as stored. Columns left out take their default. Runs with the project owner's rights: constraints and triggers apply, row-level security does not.",
    input: { projectId, table, schema, values: rowValues.describe('Column name to value, e.g. {"title": "Buy milk"}.') },
    annotations: { ...WRITE, destructiveHint: false },
    run: async (args, c) => {
      const row = await c.deps.data.insertRow(args.projectId, c.userId, args.table, args.values, args.schema);
      await c.deps.activity.append(args.projectId, {
        userId: c.userId,
        kind: ProjectActivityKind.TABLE_ROW_INSERTED,
        title: `Row inserted: ${args.table}`,
        detail: `${Object.keys(args.values).length} field(s) · via MCP`,
      });
      return row;
    },
  },
  {
    name: 'update_rows',
    title: 'Update rows',
    scope: 'data:write',
    description:
      'Set new values on every row that matches `match` and return the first updated row. Identify one row by its primary key, or by {"_bf_ctid": "..."} from select_rows. Fails with "Row not found" when nothing matches.',
    input: {
      projectId,
      table,
      schema,
      match: rowValues.describe('Column name to value identifying the row(s), e.g. {"id": 42}.'),
      values: rowValues.describe('Column name to new value, e.g. {"done": true}.'),
    },
    annotations: { ...WRITE, idempotentHint: true },
    run: async (args, c) => {
      const row = await c.deps.data.updateRow(args.projectId, c.userId, args.table, args.match, args.values, args.schema);
      await c.deps.activity.append(args.projectId, {
        userId: c.userId,
        kind: ProjectActivityKind.TABLE_ROW_UPDATED,
        title: `Row updated: ${args.table}`,
        detail: `Changed: ${Object.keys(args.values).length} field(s) · via MCP`,
      });
      return row;
    },
  },
  {
    name: 'delete_row',
    title: 'Delete a row',
    scope: 'data:write',
    description:
      'Permanently delete the first row that matches `match` (its primary key, or {"_bf_ctid": "..."} from select_rows). There is no undo.',
    input: { projectId, table, schema, match: rowValues.describe('Column name to value identifying the row, e.g. {"id": 42}.') },
    annotations: WRITE,
    run: async (args, c) => {
      const out = await c.deps.data.deleteRow(args.projectId, c.userId, args.table, args.match, args.schema);
      await c.deps.activity.append(args.projectId, {
        userId: c.userId,
        kind: ProjectActivityKind.TABLE_ROW_DELETED,
        title: `Row deleted: ${args.table}`,
        detail: 'via MCP',
      });
      return out;
    },
  },
  {
    name: 'query_sql',
    title: 'Run read-only SQL',
    scope: 'sql:read',
    description:
      'Run one read-only statement (SELECT, WITH, VALUES, TABLE or EXPLAIN) and return the rows. It runs in a read-only transaction that is always rolled back, so it cannot change data or schema. Pass values as `params`.',
    input: sqlInput,
    annotations: READ,
    run: async (args, c) =>
      sqlResult(
        await c.deps.sql.execute(args.projectId, args.query, c.userId, {
          params: args.params,
          page: args.page,
          limit: args.limit,
          readOnly: true,
        }),
      ),
  },
  {
    name: 'run_sql',
    title: 'Run SQL',
    scope: 'sql:run',
    description:
      "Run SQL as the project's database owner: writes and DDL (including DROP) take effect at once, with no undo, and row-level security does not apply. Several statements separated by ; run in order. Pass values as `params` (single statement only).",
    input: sqlInput,
    annotations: WRITE,
    run: async (args, c) =>
      sqlResult(
        await c.deps.sql.execute(args.projectId, args.query, c.userId, {
          params: args.params,
          page: args.page,
          limit: args.limit,
        }),
      ),
  },
  {
    name: 'list_buckets',
    title: 'List storage buckets',
    scope: 'storage:read',
    description: "List a project's storage buckets: name, whether public, size limit and allowed file types.",
    input: { projectId },
    annotations: READ,
    run: (args, c) => c.deps.storage.listBuckets(args.projectId, c.userId),
  },
  {
    name: 'list_objects',
    title: 'List storage objects',
    scope: 'storage:read',
    description: `List one folder level of a bucket: files (name, size, last modified) and sub-folders (entries with a \`prefix\`). At most ${MAX_OBJECTS} entries.`,
    input: {
      projectId,
      bucket: z.string().min(1).max(63).describe('Bucket name from list_buckets.'),
      prefix: z.string().max(1024).optional().describe('Folder to list, ending with "/". Omit for the top of the bucket.'),
    },
    annotations: READ,
    run: async (args, c) => {
      const all = await c.deps.storage.listObjects(args.projectId, c.userId, args.bucket, args.prefix ?? '');
      return { objects: all.slice(0, MAX_OBJECTS), truncated: all.length > MAX_OBJECTS };
    },
  },
  {
    name: 'create_bucket',
    title: 'Create a storage bucket',
    scope: 'storage:write',
    description:
      'Create a bucket in a project. Name: 3-63 letters, digits and hyphens, not starting or ending with a hyphen. Private unless `public` is true (public = every file readable at its URL, without listing).',
    input: {
      projectId,
      name: z.string().min(3).max(63).describe('Bucket name, e.g. "invoices".'),
      public: z.boolean().optional().describe('Make the files readable by anyone with the URL. Default false.'),
    },
    annotations: { ...WRITE, destructiveHint: false },
    run: async (args, c) => {
      const out = await c.deps.storage.createBucket(args.projectId, c.userId, args.name, args.public === true);
      await c.deps.activity.append(args.projectId, {
        userId: c.userId,
        kind: ProjectActivityKind.STORAGE_BUCKET_CREATED,
        title: `Storage bucket created: ${args.name}`,
        detail: `${args.public ? 'Public' : 'Private'} bucket · via MCP`,
      });
      return out;
    },
  },
  {
    name: 'delete_bucket',
    title: 'Delete a storage bucket',
    scope: 'storage:write',
    description: 'Delete a bucket. A bucket that still holds files is refused (409) unless `force` is true, which permanently deletes the bucket and every file in it. There is no undo.',
    input: {
      projectId,
      bucket: z.string().min(1).max(63).describe('Bucket name from list_buckets.'),
      force: z.boolean().optional().describe('Delete the bucket even when it holds files.'),
    },
    annotations: WRITE,
    run: async (args, c) => {
      const out = await c.deps.storage.deleteBucket(args.projectId, c.userId, args.bucket, { force: args.force === true });
      await c.deps.activity.append(args.projectId, {
        userId: c.userId,
        kind: ProjectActivityKind.STORAGE_BUCKET_DELETED,
        title: `Storage bucket deleted: ${args.bucket}`,
        detail: 'via MCP',
      });
      return out;
    },
  },
  {
    name: 'list_s3_keys',
    title: 'List S3 access keys',
    scope: 'secrets:read',
    description:
      "List a project's S3 access keys (id, name, access key id, last four of the secret, created) and the connection details: endpoint, region, path-style addressing and the bucket names an S3 client uses. Never returns a secret.",
    input: { projectId },
    annotations: READ,
    run: async (args, c) => ({
      connection: await c.deps.s3Keys.info(args.projectId, c.userId),
      keys: await c.deps.s3Keys.list(args.projectId, c.userId),
    }),
  },
  {
    name: 'create_s3_key',
    title: 'Create an S3 access key',
    scope: 'secrets:write',
    description:
      "Create an S3 access key for a project: full read/write on the project's own buckets for any standard S3 client (AWS SigV4, path-style). It bypasses storage access rules. The secret is in this answer only and cannot be shown again; store it now.",
    input: { projectId, name: z.string().min(1).max(60).describe('A label, e.g. "backup server".') },
    annotations: { ...WRITE, destructiveHint: false },
    run: (args, c) => c.deps.s3Keys.create(args.projectId, c.userId, args.name, 'mcp'),
  },
  {
    name: 'revoke_s3_key',
    title: 'Revoke an S3 access key',
    scope: 'secrets:write',
    description: 'Revoke an S3 access key. Clients using it are refused from their next request. There is no undo.',
    input: { projectId, keyId: z.string().uuid().describe('Key id from list_s3_keys.') },
    annotations: WRITE,
    run: (args, c) => c.deps.s3Keys.revoke(args.projectId, c.userId, args.keyId, 'mcp'),
  },
  {
    name: 'list_db_roles',
    title: 'List extra database roles',
    scope: 'secrets:read',
    description:
      "List a project's extra database roles: id, label, role name, kind (login or group), memberships, run-time limits, created. Never returns a password.",
    input: { projectId },
    annotations: READ,
    run: (args, c) => c.deps.projects.listExtraRoles(args.projectId, c.userId),
  },
  {
    name: 'create_db_role',
    title: 'Create an extra database role',
    scope: 'secrets:write',
    description:
      'Create an extra database role. kind "login" (default) connects with its own password; "group" is NOLOGIN and owns functions or receives grants. With `name`, the role is called <prefix>_<name> (the project must have a role prefix); without it the name is generated. The password is in this answer only; store it now. At most 10 login and 10 group roles per project.',
    input: {
      projectId,
      label: z.string().min(1).max(80).describe('A label shown in the dashboard, e.g. "API server".'),
      name: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/).optional().describe('Role name after the prefix, e.g. "app" for <prefix>_app.'),
      kind: z.enum(['login', 'group']).optional().describe('login (default) or group.'),
      memberOf: z.array(z.string().max(63)).max(10).optional().describe(
        "Roles to join. A named role may join only this project's group roles; a generated one also anon, authenticated or service_role (SET ROLE needed).",
      ),
    },
    annotations: { ...WRITE, destructiveHint: false },
    run: (args, c) =>
      c.deps.projects.createExtraRole(args.projectId, c.userId, args.label, args.memberOf ?? 'none', undefined, args.kind, args.name),
  },
  {
    name: 'reset_db_role_password',
    title: 'Reset an extra database role password',
    scope: 'secrets:write',
    description:
      'Give a login role a new generated password. Clients keep their current connection until they reconnect. The new password is in this answer only.',
    input: { projectId, roleId: z.string().uuid().describe('Role id from list_db_roles.') },
    annotations: WRITE,
    run: (args, c) => c.deps.projects.rotateExtraRolePassword(args.projectId, c.userId, args.roleId),
  },
  {
    name: 'drop_db_role',
    title: 'Drop an extra database role',
    scope: 'secrets:write',
    description:
      "Remove an extra database role. What it owns is handed to the project owner first; clients using it are refused from their next connection. There is no undo.",
    input: { projectId, roleId: z.string().uuid().describe('Role id from list_db_roles.') },
    annotations: WRITE,
    run: (args, c) => c.deps.projects.dropExtraRole(args.projectId, c.userId, args.roleId),
  },
  {
    name: 'list_auth_users',
    title: 'List auth users',
    scope: 'auth:read',
    description:
      "List the end users of a project's authentication: id, email, name, phone, enabled, verified, anonymous, created. Page with first and max.",
    input: {
      projectId,
      search: z.string().max(200).optional().describe('Match against email, username or name.'),
      first: z.number().int().min(0).optional().describe('Offset of the first user. Default 0.'),
      max: z.number().int().min(1).max(100).optional().describe('Users per page, 1-100. Default 50.'),
    },
    annotations: READ,
    run: async (args, c) => {
      const p = await c.deps.projects.findOne(args.projectId, c.userId);
      return c.deps.keycloak.listUsers(p.keycloakRealm, { search: args.search, first: args.first, max: args.max ?? 50 });
    },
  },
];

assertToolCatalogue(MCP_TOOLS);

/** Every scope that unlocks at least one tool. */
export const MCP_TOOL_SCOPES: string[] = [...new Set(MCP_TOOLS.map((t) => t.scope))];
