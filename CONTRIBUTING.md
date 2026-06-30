# Contributing to basefyio

Thank you for your interest in contributing. basefyio is an open-source project and all contributions — code, docs, bug reports, and ideas — are welcome.

---

## Before You Start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md)
- Check [open issues](https://github.com/myfyio/basefyio/issues) before opening a new one
- For large changes, open a Discussion or issue first to align on direction

---

## Development Setup

**Requirements:** Docker, Docker Compose, Node.js 20+, pnpm

```bash
git clone https://github.com/myfyio/basefyio.git
cd basefyio

# Start infrastructure services
docker compose up postgres redis keycloak minio -d

# Install dependencies
pnpm install

# Start the platform API in dev mode
cd apps/platform-api
pnpm dev

# In another terminal, start the admin UI
cd apps/admin-ui
pnpm dev
```

---

## How to Contribute

### Reporting Bugs

Open an issue using the **Bug Report** template. Include:

- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Docker version, Node version)
- Relevant logs

### Suggesting Features

Open an issue using the **Feature Request** template or start a [GitHub Discussion](https://github.com/myfyio/basefyio/discussions).

### Submitting Code

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run tests: `pnpm test`
5. Commit with a clear message (see below)
6. Push and open a Pull Request

---

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(sql): add query timeout configuration
fix(auth): handle expired JWT refresh correctly
docs(readme): update quick start instructions
chore(deps): update NestJS to 10.3
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`

---

## Code Guidelines

- TypeScript strict mode — no `any` without a comment explaining why
- NestJS module pattern — each feature is a self-contained module
- No business logic in controllers — controllers are thin, services hold logic
- Every new module needs at minimum one integration test
- No Stripe, billing, or commercial references in core modules

---

## Pull Request Checklist

- [ ] Tests pass locally (`pnpm test`)
- [ ] No new TypeScript errors (`pnpm typecheck`)
- [ ] No commercial-only features in core modules
- [ ] Docs updated if behavior changed
- [ ] PR description explains what and why

---

## What Belongs in basefyio

Core modules handle infrastructure, data, and developer experience. The following **do not** belong here:

- Payment processing (Stripe, billing)
- External SaaS integrations (QuickBooks, Salesforce)
- Cloud-specific hosting logic
- Features behind a subscription wall

If you're unsure, open a Discussion first.

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
