/**
 * Scope catalogue for platform API tokens. Each management route declares the
 * scope it needs via @Scopes(); a token missing it gets 403.
 */
export interface ScopeGroup {
  resource: string;
  label: string;
  scopes: { scope: string; description: string }[];
}

/**
 * Scope catalogue grouped by product area. Categories with a `category`
 * header render as sections in the token UI. Scope strings are
 * stable API — never rename an existing one (tokens store them verbatim).
 */
export interface ScopeGroup {
  resource: string;
  label: string;
  category: string;
  description?: string;
  scopes: { scope: string; description: string }[];
}

export const SCOPE_GROUPS: ScopeGroup[] = [
  // ── Account ────────────────────────────────────────────────────────────────
  {
    resource: 'account',
    label: 'Account',
    category: 'Account',
    description: 'Your profile, security and preferences',
    scopes: [
      { scope: 'account:read', description: 'Read your profile and teams' },
      { scope: 'account:write', description: 'Update your profile and notification preferences' },
    ],
  },
  {
    resource: 'team',
    label: 'Teams & Members',
    category: 'Account',
    description: 'Team roster, roles and invitations',
    scopes: [
      { scope: 'team:read', description: 'List teams, members and invitations' },
      { scope: 'team:write', description: 'Invite, remove and change member roles' },
    ],
  },
  {
    resource: 'billing',
    label: 'Billing',
    category: 'Account',
    description: 'Plan, subscription, invoices and usage',
    scopes: [
      { scope: 'billing:read', description: 'Read plan, subscription, usage and invoices' },
      { scope: 'billing:write', description: 'Change plan and manage the subscription' },
    ],
  },

  // ── Projects ───────────────────────────────────────────────────────────────
  {
    resource: 'projects',
    label: 'Projects',
    category: 'Projects',
    description: 'The projects themselves and their lifecycle',
    scopes: [
      { scope: 'projects:read', description: 'List and inspect projects' },
      { scope: 'projects:write', description: 'Create, rename, deactivate, restore and delete projects' },
    ],
  },
  {
    resource: 'settings',
    label: 'Project Settings',
    category: 'Projects',
    description: 'Configuration, folders and tags',
    scopes: [
      { scope: 'settings:read', description: 'Read project settings, folders and tags' },
      { scope: 'settings:write', description: 'Update project settings, folders and tags' },
    ],
  },

  // ── Database ───────────────────────────────────────────────────────────────
  {
    resource: 'data',
    label: 'Data (rows & documents)',
    category: 'Database',
    description: 'Contents of tables and collections',
    scopes: [
      { scope: 'data:read', description: 'Read rows and documents' },
      { scope: 'data:write', description: 'Insert, update and delete rows and documents' },
    ],
  },
  {
    resource: 'schema',
    label: 'Schema (tables & collections)',
    category: 'Database',
    description: 'Tables, collections, indexes, triggers and functions',
    scopes: [
      { scope: 'schema:read', description: 'Inspect tables, collections and database objects' },
      { scope: 'schema:write', description: 'Create/alter/drop tables, collections and objects' },
    ],
  },
  {
    resource: 'sql',
    label: 'SQL',
    category: 'Database',
    description: 'Direct SQL access to the project database',
    scopes: [{ scope: 'sql:run', description: 'Run SQL against a project database' }],
  },
  {
    resource: 'embeddings',
    label: 'Embeddings & Vectors',
    category: 'Database',
    description: 'Semantic search and vector indexes',
    scopes: [
      { scope: 'embeddings:read', description: 'Query embeddings and vector search' },
      { scope: 'embeddings:write', description: 'Build and update embedding indexes' },
    ],
  },

  // ── Storage & Auth ─────────────────────────────────────────────────────────
  {
    resource: 'storage',
    label: 'Storage',
    category: 'Storage & Auth',
    description: 'Buckets and objects',
    scopes: [
      { scope: 'storage:read', description: 'List and download buckets and objects' },
      { scope: 'storage:write', description: 'Upload and delete buckets and objects' },
    ],
  },
  {
    resource: 'auth',
    label: 'Authentication',
    category: 'Storage & Auth',
    description: 'End-user auth realm, users and sessions',
    scopes: [
      { scope: 'auth:read', description: 'List realm users and sessions' },
      { scope: 'auth:write', description: 'Create/update/reset users and repair the realm' },
    ],
  },

  // ── Realtime & Automation ──────────────────────────────────────────────────
  {
    resource: 'realtime',
    label: 'Realtime',
    category: 'Realtime & Automation',
    description: 'Live change broadcasting',
    scopes: [
      { scope: 'realtime:read', description: 'List realtime bindings' },
      { scope: 'realtime:write', description: 'Enable/disable realtime broadcasting' },
    ],
  },
  {
    resource: 'flows',
    label: 'Flows',
    category: 'Realtime & Automation',
    description: 'Automation flows and their runs',
    scopes: [
      { scope: 'flows:read', description: 'List flows and run history' },
      { scope: 'flows:write', description: 'Create, edit and trigger flows' },
    ],
  },
  {
    resource: 'functions',
    label: 'Edge Functions',
    category: 'Realtime & Automation',
    description: 'Serverless functions and their invocations',
    scopes: [
      { scope: 'functions:read', description: 'List functions and logs' },
      { scope: 'functions:write', description: 'Deploy, update and invoke functions' },
    ],
  },
  {
    resource: 'blueprints',
    label: 'App Builder',
    category: 'Realtime & Automation',
    description: 'Blueprints that turn spreadsheets into backends',
    scopes: [
      { scope: 'blueprints:read', description: 'List blueprints' },
      { scope: 'blueprints:write', description: 'Analyze, approve and generate apps' },
    ],
  },

  // ── Platform ───────────────────────────────────────────────────────────────
  {
    resource: 'integrations',
    label: 'Integrations',
    category: 'Platform',
    description: 'GitHub, Vercel and other connections',
    scopes: [
      { scope: 'integrations:read', description: 'List connected integrations' },
      { scope: 'integrations:write', description: 'Connect and disconnect integrations' },
    ],
  },
  {
    resource: 'backups',
    label: 'Backups & Export',
    category: 'Platform',
    description: 'Project backups, exports and restores',
    scopes: [
      { scope: 'backups:read', description: 'List backups and export jobs' },
      { scope: 'backups:write', description: 'Create backups, export and restore projects' },
    ],
  },
  {
    resource: 'secrets',
    label: 'API Keys & Secrets',
    category: 'Platform',
    description: 'Project API keys and connection credentials',
    scopes: [
      { scope: 'secrets:read', description: 'Read project API keys and connection info' },
      { scope: 'secrets:write', description: 'Rotate project API keys and credentials' },
    ],
  },
  {
    resource: 'logs',
    label: 'Logs & Activity',
    category: 'Platform',
    description: 'Activity history and request logs',
    scopes: [{ scope: 'logs:read', description: 'Read activity history and logs' }],
  },
];

export const ALL_SCOPES: Set<string> = new Set(
  SCOPE_GROUPS.flatMap((g) => g.scopes.map((s) => s.scope)),
);

export const TOKEN_PREFIX = 'bf_pat_';
