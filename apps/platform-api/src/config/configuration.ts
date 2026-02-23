export default () => ({
  port: parseInt(process.env.PORT || '4000', 10),

  database: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'kolaybase',
    password: process.env.POSTGRES_PASSWORD || 'kolaybase_secret',
    name: process.env.POSTGRES_DB || 'kolaybase',
  },

  keycloak: {
    url: process.env.KEYCLOAK_URL || 'http://localhost:8080',
    adminUser: process.env.KEYCLOAK_ADMIN_USER || 'admin',
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin',
    adminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID || 'admin-cli',
  },
});
