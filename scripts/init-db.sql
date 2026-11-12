-- Creates the Keycloak database alongside the default kolaybase database.
-- This file is mounted into the PostgreSQL container's initdb directory.

CREATE DATABASE keycloak;
GRANT ALL PRIVILEGES ON DATABASE keycloak TO kolaybase;

-- Lock down platform DB: only the admin user can connect.
REVOKE CONNECT ON DATABASE kolaybase FROM PUBLIC;
GRANT CONNECT ON DATABASE kolaybase TO kolaybase;
