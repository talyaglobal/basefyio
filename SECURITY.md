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

## Security architecture

basefyio is built around **isolation by design** and defense in depth:

- **Per-project database isolation** — every project gets its own PostgreSQL
  database and connecting role. There are no shared schemas, so a compromise or
  mistake in one project cannot reach another's data.
- **Row-level security (RLS)** — the public data API executes every request
  inside a transaction under a least-privileged role (`SET LOCAL ROLE`) with the
  caller's verified JWT claims exposed to Postgres (`request.jwt.claims`), so
  RLS policies are enforced by the database itself, not just the application.
- **Parameterized queries + identifier sanitization** — the data API never
  string-concatenates user input; values are bound and identifiers validated.
- **Authentication** — JWTs are validated against a standard OpenID Connect
  provider's published JWKS. Sign-in is protected by account lockout, CAPTCHA,
  generic (non-enumerating) error messages, OAuth `state`/PKCE, and replay-nonce
  protection for the CLI login.
- **Encrypted credentials at rest** — project database passwords are stored
  encrypted (AES-256-GCM) via `DB_CRED_ENC_KEY` and decrypted only in memory.
- **App-level rate limiting** — a global per-IP throttle (real client IP via
  `X-Forwarded-For`) provides defense in depth against brute-force and DoS, on
  top of the auth-specific lockout.
- **Other controls** — `helmet` headers, a global `ValidationPipe`, Stripe
  webhook signature verification, a hardened SQL statement denylist for the
  admin SQL console, and full audit logging of SQL and sensitive actions.

## Threat model (what this protects against)

- **Cross-tenant data access** — mitigated by per-project DB + role isolation and RLS.
- **SQL injection** — mitigated by parameterization and identifier validation.
- **Credential theft from a platform-DB dump** — mitigated by at-rest encryption of project DB passwords.
- **Brute-force / credential stuffing / DoS** — mitigated by account lockout, CAPTCHA, and per-IP rate limiting.
- **Out of scope / operator responsibility** — securing the host, the Docker
  socket, TLS termination, and the secrets in `.env` (see the checklist below).

## Hardening checklist for self-hosters

basefyio ships with development-friendly defaults. **Before exposing an instance
to the internet**, make sure you:

- Replace **every** default credential (`POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
  `KEYCLOAK_ADMIN_PASSWORD`, `PGBOUNCER_ADMIN_PASSWORD`, …) with strong, unique values.
- Set a strong `QB_ENCRYPTION_KEY` if you enable the QuickBooks integration.
- Set a strong `DB_CRED_ENC_KEY` (base64/hex 32 bytes) to encrypt project
  database credentials at rest, and **back it up** — losing it makes stored
  credentials unrecoverable.
- Terminate TLS in front of the stack (e.g. a reverse proxy) and never expose the
  database, Keycloak admin, or MinIO console directly.
- Keep secrets in your `.env` only — it is git-ignored; never commit it.
- Restrict the Docker socket; the platform uses it to provision per-project infra.
