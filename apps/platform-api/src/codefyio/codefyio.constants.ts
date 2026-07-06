/** Root path (deliberately outside the global `/api` prefix). */
export const CODEFYIO_PREFIX = '_codefyio';

/** Adapter version reported by /health and the manifest. */
export const ADAPTER_VERSION = '1.0.0';

/**
 * The complete, least-privilege action allow-list. `/action` rejects anything
 * not listed here, and it is also advertised in the manifest so the IDE knows
 * what it may call. Keep this in sync with docs/CODEFYIO_ADAPTER.md.
 */
export const CODEFYIO_ACTIONS = [
  {
    action: 'project.status',
    description: "Health/status of a project (resourceId = project id).",
    params: {},
  },
  {
    action: 'project.tables',
    description: 'List the tables/collections in a project.',
    params: {},
  },
  {
    action: 'sql.run',
    description: 'Run a read/query SQL statement against a project.',
    params: { query: 'string' },
  },
  {
    action: 'realtime.list',
    description: 'List a project\'s realtime bindings (which tables/collections broadcast).',
    params: {},
  },
  {
    action: 'realtime.set',
    description: 'Enable/disable realtime broadcast for a table or collection.',
    params: { kind: "'table' | 'collection'", entity: 'string', enabled: 'boolean' },
  },
] as const;

export const ALLOWED_ACTIONS = new Set<string>(CODEFYIO_ACTIONS.map((a) => a.action));
