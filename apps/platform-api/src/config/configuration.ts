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

  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.RESEND_FROM_EMAIL || 'Kolaybase <noreply@kolaybase.com>',
    replyTo: process.env.RESEND_REPLY_TO || 'support@kolaybase.com',
  },
});
