# Provider Authoring Guide

## Overview

A **provider** encapsulates all infrastructure-specific logic for a single backend (Docker, Hetzner, AWS, etc.). Every provider implements the `ProvisioningProvider` interface exported from `@basefyio/provisioning-core`. The control plane calls the interface methods; providers never interact with the database or the HTTP layer directly.

---

## Interface Contract

```ts
interface ProvisioningProvider {
  getCapabilities(): ProviderCapability;
  plan(spec: DesiredSpec): Promise<PlanResult>;
  apply(spec: DesiredSpec, input: ApplyInput): Promise<ApplyResult>;
  rollback(operationId: string): Promise<RollbackResult>;
  healthCheck(): Promise<HealthCheckResult>;
}
```

All five methods are required. Throw an `Error` (or a typed `ProvisioningError`) if a method is structurally unsupported — never return a silent no-op.

---

## `getCapabilities()`

Returns a static `ProviderCapability` object. This is called at startup and on `GET /v1/provisioning/providers`; it must be synchronous-safe (no I/O).

```ts
interface ProviderCapability {
  provider: string;            // machine-readable id, e.g. "docker"
  displayName: string;         // human label, e.g. "Docker (local)"
  supportsRollback: boolean;
  supportedResources: ResourceCapability[];
}

interface ResourceCapability {
  type: string;                // e.g. "container", "volume", "network"
  supportsCreate: boolean;
  supportsUpdate: boolean;
  supportsRollback: boolean;
  supportsDryRun: boolean;
}
```

---

## `plan()`

Computes the diff between current state and `desiredSpec`. **No real API calls** — read-only introspection of the target system is allowed, but nothing must be mutated.

```ts
async plan(spec: DesiredSpec): Promise<PlanResult> {
  // Returns the list of changes the subsequent apply() would make.
  return {
    changes: [
      { action: 'CREATE', resourceType: 'container', resourceId: 'my-app' },
    ],
    estimatedCost: { currency: 'USD', monthly: 0 },
  };
}
```

`PlanResult.changes` is an array of `PlannedChange` objects; `estimatedCost` may be `null` if the provider cannot estimate.

---

## `apply()`

Executes the changes described by `spec`. Returns the resulting resource list and a structured log.

```ts
async apply(spec: DesiredSpec, input: ApplyInput): Promise<ApplyResult> {
  return {
    resources: [
      { id: 'container-abc123', type: 'container', status: 'RUNNING', metadata: {} },
    ],
    logs: [
      { level: 'info', message: 'Container my-app started', timestamp: new Date() },
    ],
  };
}
```

The control plane writes `ApplyResult.resources` to the `ProvisionedResource` table after a successful apply.

---

## Resources as Durable State

Resources are the canonical source of provisioned infrastructure state. Operations are transient — they execute, succeed or fail, and end. Resources are durable — they persist across operations and represent the actual infrastructure that exists.

When your `apply()` method returns `{ resources, ... }`, the platform writes those resources to the database. Subsequent operations for the same project read from this resource table to understand current state before planning the next diff.

Key implications for provider authors:
- Return all resources the provider manages after every apply, not just new ones.
- Set `externalId` to the cloud provider's resource ID — this is the link to real infrastructure.
- Set `actualSpec` to the observed state returned by the provider API, not the desired spec. These may differ (e.g. auto-assigned IP addresses).
- Never expose `rollbackSpec` in your public API surface — it is a platform internal used for rollback orchestration.

---

## Dry-Run Semantics

When `input.dryRun === true`, skip all mutating API calls and return an empty or mocked result. The contract:

- `resources` may be an empty array or a mocked representation.
- `logs` should include at least one entry indicating a dry-run was performed.
- The operation is recorded in the database with `dryRun: true`; no `ProvisionedResource` rows are written.

```ts
if (input.dryRun) {
  return { resources: [], logs: [{ level: 'info', message: 'Dry-run: no changes applied', timestamp: new Date() }] };
}
```

---

## `rollback()`

Called by the control plane when a partial-failure rollback is triggered. Receives the `operationId` whose resources must be torn down.

```ts
async rollback(operationId: string): Promise<RollbackResult> {
  // Look up resources written during the operation and destroy them.
  return { rolledBack: ['container-abc123'], errors: [] };
}
```

If `getCapabilities().supportsRollback` is `false`, throw `new ProvisioningError('ROLLBACK_NOT_SUPPORTED')`.

---

## `healthCheck()`

Verifies connectivity to the backing infrastructure. Called periodically and on `GET /v1/provisioning/providers/:provider/health`.

```ts
async healthCheck(): Promise<HealthCheckResult> {
  return { healthy: true, latencyMs: 12, detail: 'Docker daemon reachable' };
}
```

---

## Registering a Provider

Open `apps/platform-api/src/provisioning/provisioning.module.ts` and add the provider to the `PROVIDER_REGISTRY_PROVIDERS` factory:

```ts
// provisioning.module.ts
{
  provide: PROVIDER_REGISTRY_PROVIDERS,
  useFactory: (docker: DockerProvider, hetzner: HetznerProvider, myProvider: MyProvider) => [
    docker,
    hetzner,
    myProvider,   // <-- add here
  ],
  inject: [DockerProvider, HetznerProvider, MyProvider],
},
```

Also declare `MyProvider` in the `providers` array of the same module so NestJS can inject it.

---

## Minimal Provider Skeleton

```ts
import { Injectable } from '@nestjs/common';
import {
  ProvisioningProvider,
  ProviderCapability,
  DesiredSpec,
  PlanResult,
  ApplyInput,
  ApplyResult,
  RollbackResult,
  HealthCheckResult,
} from '@basefyio/provisioning-core';

@Injectable()
export class MyProvider implements ProvisioningProvider {
  getCapabilities(): ProviderCapability {
    return {
      provider: 'my-provider',
      displayName: 'My Provider',
      supportsRollback: false,
      supportedResources: [
        { type: 'server', supportsCreate: true, supportsUpdate: false, supportsRollback: false, supportsDryRun: true },
      ],
    };
  }

  async plan(spec: DesiredSpec): Promise<PlanResult> {
    return { changes: [], estimatedCost: null };
  }

  async apply(spec: DesiredSpec, input: ApplyInput): Promise<ApplyResult> {
    if (input.dryRun) {
      return { resources: [], logs: [{ level: 'info', message: 'Dry-run', timestamp: new Date() }] };
    }
    // TODO: real implementation
    return { resources: [], logs: [] };
  }

  async rollback(_operationId: string): Promise<RollbackResult> {
    throw new Error('ROLLBACK_NOT_SUPPORTED');
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, latencyMs: 0, detail: 'ok' };
  }
}
```
