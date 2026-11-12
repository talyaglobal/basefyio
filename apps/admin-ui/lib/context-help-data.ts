export interface HelpContent {
  pageTitle: string;
  description: string;
  steps: string[];
  tips?: string[];
  docPath: string;
}

/**
 * Maps project sub-paths to contextual help content.
 * The key is matched against the pathname after `/dashboard/projects/[id]`.
 */
export const HELP_MAP: Record<string, HelpContent> = {
  '': {
    pageTitle: 'Project Overview',
    description:
      'A summary of your project — database stats, recent activity, and quick actions.',
    steps: [
      'Check your table count and total row count at a glance.',
      'Review the advisor cards for security and performance tips.',
      'Use the quick-action buttons to jump to common tasks.',
    ],
    tips: ['Keep an eye on advisor warnings — they flag missing RLS policies and unused indexes.'],
    docPath: '/docs/projects/overview',
  },

  '/tables': {
    pageTitle: 'Table Editor',
    description:
      'Create, browse, and modify your database tables and rows visually — no SQL needed.',
    steps: [
      'Select a table from the left panel (or create a new one).',
      'Click "Edit table" to see and modify columns in the right panel.',
      'Add, edit, or delete rows directly in the data grid.',
      'Use the search bar to filter rows instantly.',
    ],
    tips: [
      'Right-click a column header to sort or hide columns.',
      'The column panel lets you add foreign keys to link tables.',
    ],
    docPath: '/docs/table-editor',
  },

  '/sql': {
    pageTitle: 'SQL Editor',
    description:
      'Write and run SQL queries directly against your database. Results are displayed instantly.',
    steps: [
      'Write your SQL in the editor (autocomplete helps with table/column names).',
      'Press Ctrl+Enter (or the Run button) to execute.',
      'View results in the table below — click a column header to sort.',
      'Export results as CSV or JSON with the download button.',
    ],
    tips: [
      'Use the saved queries feature to store frequently used queries.',
      'You can run multiple statements separated by semicolons.',
    ],
    docPath: '/docs/sql-editor',
  },

  '/storage': {
    pageTitle: 'Storage',
    description:
      'Upload, organize, and serve files through S3-compatible object storage (powered by MinIO).',
    steps: [
      'Create a bucket to organize your files (e.g. "avatars", "documents").',
      'Upload files by dragging them into the bucket view.',
      'Toggle a bucket to "Public" to allow direct URL access.',
      'Use presigned URLs for time-limited access to private files.',
    ],
    tips: [
      'Max file size is 50 MB. For larger files, use direct S3 upload with presigned URLs.',
      'Public buckets serve files directly — great for images and static assets.',
    ],
    docPath: '/docs/storage',
  },

  '/auth': {
    pageTitle: 'Authentication',
    description:
      'Manage your project\'s auth users, OAuth providers, and session settings (powered by Keycloak).',
    steps: [
      'View and search registered users in the user table.',
      'Enable OAuth providers (Google, GitHub, etc.) in the Providers tab.',
      'Configure redirect URLs for each provider.',
      'Use the SDK or REST API to handle login/signup in your app.',
    ],
    tips: [
      'The anon key + JWT combo gives you row-level security based on the logged-in user.',
      'Test auth flows with the built-in callback URL helper.',
    ],
    docPath: '/docs/auth',
  },

  '/api-explorer': {
    pageTitle: 'REST API',
    description:
      'Interactive reference for your project\'s auto-generated REST endpoints. Copy and paste into your app.',
    steps: [
      'Select a table from the dropdown to see its CRUD endpoints.',
      'Each card shows the full URL, headers, and example body.',
      'Click "Copy as curl" to get a ready-to-run command.',
      'Check the Filter Reference at the bottom for query syntax.',
    ],
    tips: [
      'Use the anon key for client-side reads, service key for server-side writes.',
      'Add ?select=col1,col2 to only return the columns you need.',
    ],
    docPath: '/docs/rest-api',
  },

  '/connect': {
    pageTitle: 'Connection',
    description:
      'Connection strings, API keys, and SDK configuration for your project.',
    steps: [
      'Copy the connection string for your framework (Next.js, Vite, etc.).',
      'Use the REST URL + API key for HTTP-based data access.',
      'Use the direct PostgreSQL URI for ORM tools (Prisma, Drizzle, etc.).',
    ],
    tips: [
      'The pooler URI uses PgBouncer for better connection management in serverless environments.',
      'Never expose the service key in client-side code.',
    ],
    docPath: '/docs/connection',
  },

  '/backup': {
    pageTitle: 'Backup & Export',
    description:
      'Create database backups, restore from snapshots, and export data.',
    steps: [
      'Click "Create Backup" to generate a pg_dump snapshot.',
      'Download backups as SQL files for safekeeping.',
      'Restore from a previous backup to roll back changes.',
    ],
    tips: ['Schedule regular backups before major schema changes or data migrations.'],
    docPath: '/docs/backup',
  },

  '/integrations': {
    pageTitle: 'Integrations',
    description:
      'Connect your project to GitHub for migrations and Vercel for automatic deployments.',
    steps: [
      'Link a GitHub repository to version-control your schema migrations.',
      'Connect Vercel to auto-deploy when you push to your branch.',
      'Check the status of each integration in the cards below.',
    ],
    docPath: '/docs/integrations',
  },

  '/embeddings': {
    pageTitle: 'AI / Embeddings',
    description:
      'Generate vector embeddings from your data for semantic search and AI features.',
    steps: [
      'Select a table and text column to embed.',
      'Choose an embedding model and target vector column.',
      'Run the embedding job — progress is shown in real time.',
      'Query vectors with the pgvector extension in SQL.',
    ],
    tips: ['Use JSONB columns as source if your text spans multiple fields.'],
    docPath: '/docs/embeddings',
  },

  '/settings': {
    pageTitle: 'Settings',
    description:
      'Project configuration — rename, pause, change region, or delete your project.',
    steps: [
      'Update the project name or slug.',
      'Pause the project to stop billing when not in use.',
      'View resource usage and plan limits.',
    ],
    tips: ['Paused projects retain all data but stop serving API requests.'],
    docPath: '/docs/settings',
  },
};

/**
 * Finds help content for a given full pathname.
 * Extracts the sub-path after `/dashboard/projects/[id]` and matches against HELP_MAP.
 */
export function getHelpForPath(pathname: string): HelpContent | null {
  // Extract sub-path: "/dashboard/projects/abc123/tables" → "/tables"
  const match = pathname.match(/\/dashboard\/projects\/[^/]+(.*)$/);
  if (!match) return null;

  const subPath = match[1] || '';

  // Direct match first
  if (HELP_MAP[subPath]) return HELP_MAP[subPath];

  // Try prefix match for nested routes (e.g. /settings/foo → /settings)
  const segment = '/' + (subPath.split('/')[1] || '');
  return HELP_MAP[segment] ?? null;
}
