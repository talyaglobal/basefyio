export default () => ({
  port: parseInt(process.env.PORT || '4000', 10),
  appUrl: process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',

  database: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'basefyio',
    password: process.env.POSTGRES_PASSWORD || 'basefyio_secret',
    name: process.env.POSTGRES_DB || 'basefyio',
  },

  keycloak: {
    url: process.env.KEYCLOAK_URL || 'http://localhost:8080',
    publicUrl: process.env.KEYCLOAK_PUBLIC_URL || process.env.KEYCLOAK_URL || 'http://localhost:8080',
    adminUser: process.env.KEYCLOAK_ADMIN_USER || 'admin',
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin',
    adminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID || 'admin-cli',
    /** Comma- or space-separated extra post-logout redirect URIs for basefyio-platform (production domains, etc.) */
    postLogoutRedirectUrisExtra: process.env.KEYCLOAK_POST_LOGOUT_REDIRECT_URIS || '',
  },

  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    useSsl: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || 'basefyio',
    secretKey: process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || 'basefyio_secret',
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
    // Admin-console credentials. Written into the generated userlist AND used to
    // send RELOAD, so both sides must read this same value. Override in any real
    // deployment; the default is a local-dev convenience only.
    adminUser: process.env.PGBOUNCER_ADMIN_USER || 'pgbouncer_admin',
    adminPassword: process.env.PGBOUNCER_ADMIN_PASSWORD || 'pgbouncer_admin_pass',
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

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromEmail: process.env.EMAIL_FROM || 'basefyio <noreply@example.com>',
    replyTo: process.env.EMAIL_REPLY_TO || '',
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

  docker: {
    socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    network: process.env.DOCKER_NETWORK || 'v0-basefyio_default',
    pgImage: process.env.DOCKER_PG_IMAGE || 'pgvector/pgvector:pg16',
    minioImage: process.env.DOCKER_MINIO_IMAGE || 'minio/minio:latest',
  },

  dataEngine: {
    provider: process.env.DATA_ENGINE_PROVIDER || 'disabled',
    connectionString: process.env.NOSQL_CONNSTR || '',
    username: process.env.NOSQL_USERNAME || '',
    password: process.env.NOSQL_PASSWORD || '',
    container: process.env.DATA_ENGINE_CONTAINER || 'basefyio-apps',
    namespace: process.env.DATA_ENGINE_NAMESPACE || 'projects',
    maxDocumentKb: parseInt(process.env.DATA_ENGINE_MAX_DOC_KB || '1024', 10),
    maxNestingDepth: parseInt(process.env.DATA_ENGINE_MAX_NESTING_DEPTH || '8', 10),
    maxArrayItems: parseInt(process.env.DATA_ENGINE_MAX_ARRAY_ITEMS || '1000', 10),
  },
});
