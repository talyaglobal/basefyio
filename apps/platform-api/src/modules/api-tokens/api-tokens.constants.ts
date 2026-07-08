/**
 * Cloudflare-style scope catalogue for platform API tokens. Each management
 * route declares the scope it needs via @Scopes(); a token missing it gets 403.
 */
export interface ScopeGroup {
  resource: string;
  label: string;
  scopes: { scope: string; description: string }[];
}

export const SCOPE_GROUPS: ScopeGroup[] = [
  {
    resource: 'account',
    label: 'Account',
    scopes: [{ scope: 'account:read', description: 'Read your profile and teams' }],
  },
  {
    resource: 'projects',
    label: 'Projects',
    scopes: [
      { scope: 'projects:read', description: 'List and inspect projects' },
      { scope: 'projects:write', description: 'Create, rename, pause, restore, delete projects' },
    ],
  },
  {
    resource: 'data',
    label: 'Data',
    scopes: [
      { scope: 'data:read', description: 'List/read tables and collections' },
      { scope: 'data:write', description: 'Insert/update/delete rows and documents' },
    ],
  },
  {
    resource: 'sql',
    label: 'SQL',
    scopes: [{ scope: 'sql:run', description: 'Run SQL against a project database' }],
  },
  {
    resource: 'storage',
    label: 'Storage',
    scopes: [
      { scope: 'storage:read', description: 'List/download buckets and objects' },
      { scope: 'storage:write', description: 'Upload/delete buckets and objects' },
    ],
  },
  {
    resource: 'auth',
    label: 'Authentication',
    scopes: [
      { scope: 'auth:read', description: 'List realm users and sessions' },
      { scope: 'auth:write', description: 'Create/update/reset users, repair realm' },
    ],
  },
  {
    resource: 'realtime',
    label: 'Realtime',
    scopes: [
      { scope: 'realtime:read', description: 'List realtime bindings' },
      { scope: 'realtime:write', description: 'Enable/disable realtime broadcasting' },
    ],
  },
  {
    resource: 'flows',
    label: 'Flows',
    scopes: [
      { scope: 'flows:read', description: 'List flows' },
      { scope: 'flows:write', description: 'Create and trigger flows' },
    ],
  },
  {
    resource: 'blueprints',
    label: 'App Builder',
    scopes: [
      { scope: 'blueprints:read', description: 'List blueprints' },
      { scope: 'blueprints:write', description: 'Analyze/approve/generate apps' },
    ],
  },
  {
    resource: 'billing',
    label: 'Billing',
    scopes: [{ scope: 'billing:read', description: 'Read plan, subscription and invoices' }],
  },
];

export const ALL_SCOPES: Set<string> = new Set(
  SCOPE_GROUPS.flatMap((g) => g.scopes.map((s) => s.scope)),
);

export const TOKEN_PREFIX = 'bf_pat_';
