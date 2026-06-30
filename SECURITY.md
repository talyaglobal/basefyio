# Security Policy

We take the security of basefyio seriously. Thank you for helping keep the
project and its users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **security@basefyio.com** with:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if possible)
- The affected version / commit and any relevant configuration

You can expect an acknowledgement within **3 business days**, and we'll keep you
updated as we investigate and ship a fix. We're happy to credit you in the
release notes once the issue is resolved (let us know if you'd prefer to stay
anonymous).

## Supported versions

Security fixes are applied to the latest release on the `main` branch. We
recommend always running the most recent version.

## Hardening checklist for self-hosters

basefyio ships with development-friendly defaults. **Before exposing an instance
to the internet**, make sure you:

- Replace **every** default credential (`POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
  `KEYCLOAK_ADMIN_PASSWORD`, `PGBOUNCER_ADMIN_PASSWORD`, …) with strong, unique values.
- Set a strong `QB_ENCRYPTION_KEY` if you enable the QuickBooks integration.
- Terminate TLS in front of the stack (e.g. a reverse proxy) and never expose the
  database, Keycloak admin, or MinIO console directly.
- Keep secrets in your `.env` only — it is git-ignored; never commit it.
- Restrict the Docker socket; the platform uses it to provision per-project infra.
