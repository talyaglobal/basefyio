# Release Gate

This is the contract for every basefyio release. **Nothing ships until every item
below is true.** Boxes are checked at release-readiness review, not aspirationally.

Status shown is for the **`v0.1.0-alpha`** target. Items already verified are
checked; the rest are gated on the platform-api stabilization pass.

---

## Repository

- [x] Apache 2.0 license
- [ ] No proprietary references (no kolaybase-new / internal remnants)
- [ ] No secrets committed
- [ ] README matches reality
- [ ] Roadmap matches reality

## Platform API

- [x] `pnpm typecheck` passes
- [x] `pnpm build` passes
- [x] `/api/health` returns 200 *(global prefix `api`; verified `{"status":"ok"}`)*
- [x] Prisma client generates
- [x] Database migrations apply *(initial migration `..._init` applied; `migrate deploy` clean)*
- [x] No Drizzle references

## Packages

- [x] CLI builds
- [x] SDK builds
- [x] Tests pass *(cli: 5, sdk: 4)*

## CI

> The `platform-api` job below is **configured and locally validated** (all
> steps run green on the dev machine). "Full CI green" stays unchecked until a
> real run executes on the GitHub runner after the stabilization commit lands.

- [ ] Full CI green (including platform-api) *(awaits push — config validated locally)*
- [x] PostgreSQL service container *(pgvector/pgvector:pg16, `platform-api` job)*
- [x] Redis service container *(redis:7-alpine, `platform-api` job)*
- [x] Integration tests *(health e2e — boots HealthController over HTTP)*
- [x] `--frozen-lockfile` install

## Security

- [ ] Secret scan
- [ ] License scan
- [ ] Dependency audit
- [ ] No commercial modules in core
- [ ] No imports from `_deferred/`

## OSS Audit

Run before the repository goes public:

- [ ] No references to internal repositories
- [ ] No references to proprietary company infrastructure (internal domains, customer names)
- [ ] No TODOs mentioning commercial functionality
- [ ] No temporary compile stubs unintentionally exposed
- [ ] All public package names use `@basefyio/*`
- [ ] No dead links in docs
- [ ] Package metadata correct (name, license, repository URLs)
- [ ] `docker-compose.yml` reviewed (no secrets, sane defaults)
- [ ] `.env.example` reviewed (no real credentials)
- [ ] GitHub Actions reviewed (no leaked tokens, correct triggers)

## Documentation

- [x] README
- [x] Quick Start
- [x] Architecture
- [x] Roadmap
- [x] Contributing

## Pre-Launch Dry Run

When every box above is green, **do not flip the repo public yet.** First validate
the most important OSS journey on a **clean machine**, as a first-time contributor —
using *only* the README, running the documented commands exactly as written:

- [ ] Clone the repository
- [ ] Follow only the README (no hidden knowledge required)
- [ ] Run the documented commands exactly as written
- [ ] `/api/health` endpoint reachable
- [ ] CLI works (`basefyio --version`, `basefyio doctor`)
- [ ] SDK example works
- [ ] Docs never require undocumented steps

## Release

Release name: **basefyio v0.1.0-alpha — Foundation Release**

> **Branching:** cut a `release/v0.1` branch before launch. `release/v0.1` accepts
> only bug fixes, doc corrections, and release-gate items; new features continue on
> `main` / `feature/*` after the alpha is tagged.

- [ ] Tag `v0.1.0-alpha`
- [ ] GitHub Release notes (state Included vs Deferred explicitly)
- [ ] Changelog
- [ ] Repository public
- [ ] GitHub Discussions + Issues enabled
- [ ] Announcement

---

After `v0.1.0-alpha` ships, **v0.1 is frozen except for bug fixes.** New
capabilities ship through planned releases (`v0.1.x`, `v0.2`, …), not by
expanding the scope of a published release. See [ROADMAP.md](ROADMAP.md).
