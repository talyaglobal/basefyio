# ADR-0004: Tenant Isolation Architecture

**Status:** Accepted  
**Date:** 2026-06-12

## Context

Basefyio is a multi-tenant platform. Each project gets its own PostgreSQL database (logical isolation). The blueprint → app pipeline generates RLS policies that enforce role-based row-level access within each tenant's database.

## Isolation Layers

| Layer | Mechanism | Enforced by |
|-------|-----------|-------------|
| Platform data | Prisma with `teamId` / `projectId` filters | Service layer |
| Tenant data | Separate PostgreSQL database per project | ProjectsService.create() |
| Row-level access | Postgres RLS + `app_role` JWT claim | PolicyCompilerService + ItemPolicyGuard |
| File storage | MinIO keys scoped to `projectId/...` | ItemFilesService |
| Intelligence | projectId validated before SQL execution | IntelligenceService |
| Supabase-compat | `x-project-id` header, falls through to ItemsService | SupabaseCompatService |

## Threat Model

- **Cross-tenant data access via API**: Mitigated by teamId/projectId guards in every service
- **SQL injection via /intelligence/ask**: Mitigated by UNSAFE_SQL_PATTERN + read-only Pool
- **File path traversal**: Mitigated by structured MinIO keys (no user input in path)
- **RLS bypass**: Mitigated by FORCE ROW LEVEL SECURITY on all tenant tables

## Known Gaps (Sprint 10 backlog)

- Supabase-compat: no auth validation on `x-project-id` header (trusts caller)
- IntelligenceService: no per-project DB user (uses project owner credentials)
- ItemFilesService: no virus scanning on uploads

## Decision

Ship with current isolation model for launch. Supabase-compat auth and per-project DB users are Sprint 11 items.
