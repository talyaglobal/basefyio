# Contributing to basefyio

Thanks for your interest in contributing! This guide covers how to get a local
environment running and what we expect in a pull request.

## Getting started

**Prerequisites:** Docker & Docker Compose, Node.js 20+.

```bash
git clone https://github.com/talyaglobal/basefyio.git
cd basefyio
cp .env.example .env        # then fill in values
docker compose up -d        # Postgres, Keycloak, MinIO, Redis
```

Then run the apps you're working on (see each app's README):

```bash
# Platform API
cd apps/platform-api && npm install && npm run start:dev

# Admin UI
cd apps/admin-ui && npm install && npm run dev
```

## Repository layout

- `apps/platform-api` — NestJS control-plane API (auth, projects, SQL, storage, billing)
- `apps/admin-ui` — Next.js dashboard
- `apps/website` — marketing site & docs
- `packages/sdk` — JavaScript/TypeScript client (`basefyio-js`)
- `packages/cli` — command-line tool (`basefyio-cli`)
- `packages/geo`, `packages/data-engine` — supporting libraries

## Development workflow

1. **Fork** the repo and create a branch from `main`:
   `git checkout -b feat/short-description`
2. Make your change. Keep it focused — one logical change per PR.
3. Make sure it builds and type-checks:
   ```bash
   npx tsc --noEmit        # in the app/package you touched
   npm run lint            # if the package defines it
   ```
4. Add or update tests where it makes sense.
5. Commit with a clear, conventional message (e.g. `fix(auth): …`, `feat(sdk): …`).
6. Open a pull request and fill in the template.

## Pull request guidelines

- Describe **what** changed and **why**.
- Link any related issue.
- Keep unrelated formatting churn out of the diff.
- Don't commit secrets, `.env` files, or generated build output.
- CI must pass before review.

## Reporting bugs & requesting features

Use the GitHub issue templates. For security issues, follow
[SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Code of conduct

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
