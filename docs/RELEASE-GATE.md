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

- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] `/health` returns 200
- [ ] Prisma client generates
- [ ] Database migrations apply
- [ ] No Drizzle references

## Packages

- [x] CLI builds
- [x] SDK builds
- [x] Tests pass *(cli: 5, sdk: 4)*

## CI

- [ ] Full CI green (including platform-api)
- [ ] PostgreSQL service container
- [ ] Redis service container
- [ ] Integration tests
- [ ] `--frozen-lockfile` install

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

## Release

Release name: **basefyio v0.1.0-alpha — Foundation Release**

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
