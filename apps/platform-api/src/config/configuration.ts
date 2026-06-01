export default () => ({
  port: parseInt(process.env.PORT || '4000', 10),
  appUrl: process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',

  database: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'kolaybase',
    password: process.env.POSTGRES_PASSWORD || 'kolaybase_secret',
    name: process.env.POSTGRES_DB || 'kolaybase',
  },

  keycloak: {
    url: process.env.KEYCLOAK_URL || 'http://localhost:8080',
    publicUrl: process.env.KEYCLOAK_PUBLIC_URL || process.env.KEYCLOAK_URL || 'http://localhost:8080',
    adminUser: process.env.KEYCLOAK_ADMIN_USER || 'admin',
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin',
    adminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID || 'admin-cli',
    /** Comma- or space-separated extra post-logout redirect URIs for kolaybase-platform (production domains, etc.) */
    postLogoutRedirectUrisExtra: process.env.KEYCLOAK_POST_LOGOUT_REDIRECT_URIS || '',
  },

  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    useSsl: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || 'kolaybase',
    secretKey: process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || 'kolaybase_secret',
    publicEndpoint: process.env.MINIO_PUBLIC_ENDPOINT || 'localhost',
    publicPort: parseInt(process.env.MINIO_PUBLIC_PORT || process.env.MINIO_PORT || '9000', 10),
    publicSsl: process.env.MINIO_PUBLIC_SSL || 'false',
  },

  pgbouncer: {
    host: process.env.PGBOUNCER_HOST || 'pgbouncer',
    port: parseInt(process.env.PGBOUNCER_PORT || '6432', 10),
    externalHost: process.env.PGBOUNCER_EXTERNAL_HOST || 'localhost',
    externalPort: parseInt(process.env.PGBOUNCER_EXTERNAL_PORT || '6432', 10),
    configDir: process.env.PGBOUNCER_CONFIG_DIR || '/etc/pgbouncer',
  },

  /**
   * Public hostname/port for direct Postgres (migrations). Optional: defaults to pooler host/port.
   * Local Docker example: POSTGRES_PUBLIC_HOST=localhost POSTGRES_PUBLIC_PORT=5433 (host-mapped Postgres).
   */
  postgresPublic: {
    directHost: (process.env.POSTGRES_PUBLIC_HOST || '').trim(),
    directPort: (() => {
      const v = process.env.POSTGRES_PUBLIC_PORT;
      if (v == null || v.trim() === '') return undefined;
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? undefined : n;
    })(),
  },

  publicApiUrl: process.env.PUBLIC_API_URL || 'http://localhost:4000',
  websiteUrl: process.env.WEBSITE_URL || 'http://localhost:3002',

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.RESEND_FROM_EMAIL || 'Kolaybase <noreply@kolaybase.com>',
    replyTo: process.env.RESEND_REPLY_TO || 'support@kolaybase.com',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
  },

  embedding: {
    /** Set to "false" to disable all embedding / vector search without removing the module. */
    enabled: process.env.EMBEDDING_ENABLED !== 'false',
    /** OpenAI embedding model. text-embedding-3-small is cost-effective and high quality. */
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    /** Hard cap on daily OpenAI token usage to prevent runaway costs (default 1M). */
    maxDailyTokens: parseInt(process.env.EMBEDDING_MAX_DAILY_TOKENS || '1000000', 10),
  },

  oauth: {
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    githubClientId: process.env.GITHUB_CLIENT_ID || '',
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    githubTeamsClientId: process.env.GITHUB_TEAMS_CLIENT_ID || '',
    githubTeamsClientSecret: process.env.GITHUB_TEAMS_CLIENT_SECRET || '',
    vercelClientId: process.env.VERCEL_CLIENT_ID || '',
    vercelClientSecret: process.env.VERCEL_CLIENT_SECRET || '',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  /** Google Search Console + GA4 (service account JSON; grant Viewer in GSC + GA4). */
  marketing: {
    serviceAccountJson: process.env.GOOGLE_MARKETING_SERVICE_ACCOUNT_JSON || '',
    serviceAccountJsonB64: process.env.GOOGLE_MARKETING_SA_JSON_B64 || '',
    gscSiteUrl: process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL || '',
    ga4PropertyId: process.env.GOOGLE_ANALYTICS_PROPERTY_ID || '',
    /** Email to impersonate via domain-wide delegation (e.g. admin@company.com). */
    impersonateEmail: process.env.GOOGLE_MARKETING_IMPERSONATE_EMAIL || '',
    /** Optional full URL for URL Inspection when property is sc-domain:… */
    inspectUrlOverride: process.env.GOOGLE_SEARCH_CONSOLE_INSPECT_URL || '',
  },

  docker: {
    socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    network: process.env.DOCKER_NETWORK || 'v0-kolaybase_default',
    pgImage: process.env.DOCKER_PG_IMAGE || 'pgvector/pgvector:pg16',
    minioImage: process.env.DOCKER_MINIO_IMAGE || 'minio/minio:latest',
  },
});
