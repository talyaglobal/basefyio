-- Creates the Keycloak database alongside the default kolaybase database.
-- This file is mounted into the PostgreSQL container's initdb directory and
-- runs once, on an empty data directory, as POSTGRES_USER — whatever that role
-- is called (.env.example names it basefyio), hence CURRENT_USER.

CREATE DATABASE keycloak;
GRANT ALL PRIVILEGES ON DATABASE keycloak TO CURRENT_USER;

-- Lock down platform DB: only the admin user can connect.
REVOKE CONNECT ON DATABASE kolaybase FROM PUBLIC;
GRANT CONNECT ON DATABASE kolaybase TO CURRENT_USER;
