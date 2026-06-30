# _deferred/

This directory is a **boundary marker / documentation area** for modules that are intentionally excluded from basefyio v0.1. It does **not** guarantee that the full source of those modules exists in this repository — some deferred code may remain only in the private source repository or in future MYFYIO repositories.

## Why deferred?

Per the **Core Acceptance Rule** (see `docs/architecture.md`): a module belongs in basefyio core only if it satisfies all three:

1. useful without AI/LLMs
2. generally applicable to every basefyio deployment
3. no dependency on commercial or hosted services

The modules below fail criterion 1 and are AI-specific.

## Deferred areas

These capabilities are intentionally excluded from basefyio v0.1. Their source is not necessarily present here — it may live in the private source repository or in the listed MYFYIO product.

| Area | Destination |
|---|---|
| `agent` | agentfyio |
| `rag` | agentfyio |
| `embedding` | agentfyio |
| `recommendation` | agentfyio |

## Rules

- Nothing in `apps/` or `packages/` may import from `_deferred/`.
- If deferred code is later added here, it **must remain excluded** from `tsconfig`, CI, package exports, and runtime imports.
- When agentfyio is initialized, deferred capabilities are built or extracted there — not wired back into basefyio core.

## Current state

`_deferred/` is currently a documentation placeholder recording the core/deferred boundary. It does not assert that the full module source exists in this repo; the authoritative source may remain in the private source repository or a future MYFYIO repository.
