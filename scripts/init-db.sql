-- Creates the Keycloak database alongside the default basefyio database.
-- This file is mounted into the PostgreSQL container's initdb directory.

CREATE DATABASE keycloak;
GRANT ALL PRIVILEGES ON DATABASE keycloak TO basefyio;

-- Lock down platform DB: only the admin user can connect.
REVOKE CONNECT ON DATABASE basefyio FROM PUBLIC;
GRANT CONNECT ON DATABASE basefyio TO basefyio;
