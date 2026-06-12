# Changelog

All notable changes are documented here.

## [Unreleased] — Sprint 10 branch (askin)

### Added
- Sprint 3: AI understanding layer — type inference, domain detection, OpenAI structured output, BusinessModel generation
- Sprint 4: Generation pipeline — BullMQ generate job, DDL generation, AppEntity seeding, BuildPackage emit, nfyio-runtime skeleton
- Sprint 5: NL→SQL intelligence — `/intelligence/ask`, dashboard widgets, save-widget, nfyio detail/dashboard renderers
- Sprint 6: Go-to-market — ApplicationModel editor (admin-ui), Excel re-sync, invite flow, quota enforcement, AppSource manifest
- Sprint 7: Items CRUD API — `/v1/projects/:projectId/items/:entityName` with filtering/sorting/cursor pagination; SDK + CLI
- Sprint 8: RBAC + Files — ItemPolicyGuard, PolicyCompilerService, RLS policy application, file upload/download via MinIO
- Sprint 9: Flows + Supabase-compat — flow engine (trigger→action), `/rest/v1` Supabase wire format, content layer docs
- Sprint 10: Hardening — tenant isolation audit, k6 load test scripts, launch checklist, ADRs (Couchbase go/no-go, tenant isolation)

### Changed
- Rebrand: `BASEFYIO_*` env vars primary, `KOLAYBASE_*` fallback, CI grep gate
- AiService: added `complete(prompt)` method, module now exports service
- QueueModule: FLOW_QUEUE + BLUEPRINT_GENERATE_QUEUE registered

### Architecture Decisions
- ADR-0003: Couchbase deferred — PostgreSQL JSONB sufficient until D8 gate
- ADR-0004: Tenant isolation — per-project DB + RLS + ItemPolicyGuard

## [0.1.0] — Sprint 1–2 base (c82fb51)

### Added
- Provisioning module: operation retry, provider health, cancellation hardening
- Blueprint module: Prisma models (Blueprint, ApplicationVersion, AppEntity, DomainTemplate)
- packages/blueprint: Zod schemas + pure functions (deriveApplicationModel, buildPackage, deriveUIModel)
- Rebrand: BASEFYIO_ primary env vars, CI check script
