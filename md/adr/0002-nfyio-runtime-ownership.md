# ADR-0002: Basefyio Owns Runtime Data; Nfyio Owns Deployment

> Status: **Accepted** | Date: 2026-06-06 | Decider: askin
> Depends on: ADR-0001 (D2 metadata split, D3 API surface, D4 runtime model, D6 permissions)
> Input: `EXCEL-TO-APP-PLAN.md` (Doc 4) §4, §7 — boundary re-cut by this ADR

## Context

ADR-0001 locked `Excel → AI Understanding → Application Model → Nfyio Runtime` but the boundary needed a precise cut. An earlier draft framed it as a data handoff ("Basefyio transfers a package to Nfyio"), implying Nfyio could become a second home for application data. That is wrong: nothing is transferred. The correct analogy:

```
Basefyio ≈ Supabase + Directus + APEX  (metadata/data brain)
Nfyio    ≈ Vercel                      (domain, deployment, hosting, delivery)
```

## Decision

```
Basefyio = runtime database + app metadata + /items API + permissions + data engine
Nfyio    = domain + deployment + hosting + runtime delivery + edge/web/mobile ops
```

```
Excel Add-in
   ↓
Basefyio
   ├─ AI understands workbook
   ├─ ApplicationModel (+ versions)
   ├─ Tenant PostgreSQL
   ├─ _bf_collections / _bf_fields / _bf_permissions
   ├─ /items/:collection (+ /rest/v1 compat)
   └─ auth + RLS + data engine
        ↓ (consumed live, never copied)
Nfyio
   ├─ deploys the app runtime
   ├─ connects domains
   ├─ serves web/mobile apps
   ├─ SSL / CDN / preview URLs
   └─ deployment lifecycle
```

**Basefyio remains the system of record** for the runtime DB, `_bf_*` metadata, auth, permissions, and all APIs. **Nfyio consumes the Basefyio ApplicationModel + APIs** and owns deployment, domain connection, hosting, previews, SSL, and delivery.

Hard rules:

1. **Nfyio never becomes the app database.** All application data lives in tenant PostgreSQL behind the Data Engine; Nfyio reads and writes it only through `/items` / `/rest/v1` with project keys, live at request time.
2. **Nfyio never owns `_bf_*` metadata.** Collections, fields, permissions, roles, flows are Basefyio runtime metadata (ADR-0001 D2). Nfyio gets a provider-neutral, read-only view (the **Application Package**, Appendix A), never the registry itself.
3. **Nfyio deploys and serves applications backed by Basefyio.** Its artifacts are deployments, hostnames, certificates, CDN config, preview URLs, and the derived UI Model — all disposable and regenerable; none are a source of truth for data or schema.
4. **No data handoff exists.** The Application Package is a *read model* of the ApplicationModel (version-pinned, schema-validated in `packages/blueprint`), fetched and cached by Nfyio, invalidated on version bump. It carries definitions and design hints — never records, credentials, or provider internals (PostgreSQL/Keycloak/MinIO/RLS). The term "build package" is retired: no build occurs in this architecture.
5. **Enforced mechanically.** `apps/nfyio-runtime` may import only `packages/blueprint` + `packages/sdk`; no platform-api internals, no DB access — CI fails on violation. Any Nfyio need not satisfied by the package or a neutral API is a P0 boundary bug, fixed by extending the contract (a new `ApplicationPackageV1` field or neutral endpoint), never by a direct peek.

V1 deployment shape: both sides live in this monorepo and ship as one system; the boundary is logical and contract-enforced. A physical split (separate service/billing/third-party builders) stays a cheap later decision because of rules 1–5.

## Rationale

- A Vercel-style Nfyio keeps exactly one system of record. Two homes for data or metadata would recreate the dual-registry problem ADR-0001 D2 eliminated.
- Live API consumption means edits are instantly live (no rebuilds, no sync, no drift) — the property that makes the 5-minute promise and the 100k-project scale model work.
- Deployment/domain/SSL/CDN is a genuinely separable competency and brandable product; data gravity is not.

## Consequences

- Step 2 starts with the `packages/blueprint` contract (ApplicationModel + `ApplicationPackageV1`, Appendix A) — it is the inter-product API.
- Wildcard DNS, cert automation, preview URLs, package fetch/cache/invalidation = Nfyio-side infrastructure (Step 2 Phase 0/4).
- Step 3's content & functions layer is entirely Basefyio-side; Nfyio benefits automatically through the same API surface.
- AI chat ("Ask your data") is Basefyio intelligence exposed via a neutral endpoint (`/intelligence/ask`); Nfyio only renders it.
- Sample/seed records are imported into tenant PostgreSQL by Basefyio's generation pipeline — they are not package contents.

## Appendix A — Application Package contract

**`ApplicationPackageV1` is the only contract Nfyio consumes.** Zod-defined in `packages/blueprint`; every field addition is a contract change reviewed against this ADR — no ad hoc extensions.

```ts
interface ApplicationPackageV1 {
  version: string;                    // package schema version + ApplicationVersion ref
  application: ApplicationModel;      // provider-neutral application definition
  navigation: NavigationModel;        // nav structure, role-gated entries
  pages: PageDefinition[];            // list/detail/form/dashboard/chart definitions
  entities: EntityView[];             // read-only entity/field views (from _bf_*, neutral)
  permissions: PermissionView[];      // role → capability view (not RLS SQL)
  uiModel: UIModel;                   // derived by Nfyio via deriveUIModel(); disposable
  theme: ThemeDefinition;             // design hints, branding, density, domain idioms
}
```

Explicitly **not** in the package: records/sample data, credentials or keys, `_bf_*` registry rows, RLS SQL, Keycloak/PostgreSQL/MinIO internals. Data and auth are reached only live via `/items`, `/rest/v1`, and the project auth endpoints.
