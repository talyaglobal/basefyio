import { Injectable } from '@nestjs/common';

// ── Desired state ────────────────────────────────────────────

export interface DesiredResource {
  type: string;
  name: string;
  spec: Record<string, unknown>;
}

// ── Current state (from DB rows) ─────────────────────────────

export interface CurrentResource {
  id: string;
  type: string;   // Prisma `kind` — uppercase in DB
  name: string;
  status: string;
  desiredSpec: Record<string, unknown>;
  actualSpec: Record<string, unknown> | null;
  externalId: string | null;
}

// ── Plan output ──────────────────────────────────────────────

export interface PlanAction {
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'NOOP';
  resourceType: string;
  resourceName: string;
  reason: string;
  desiredSpec?: Record<string, unknown>;
  currentSpec?: Record<string, unknown>;
}

export interface ProvisioningPlan {
  actions: PlanAction[];
  summary: {
    create: number;
    update: number;
    delete: number;
    noop: number;
  };
}

// ── Planner input ────────────────────────────────────────────

export interface PlannerInput {
  projectId: string;
  provider: string;
  region: string;
  datacenter: string | null;
  /**
   * Raw operation input payload. Expected shape:
   *   { resources: Array<{ type, name, spec }> }
   * If absent or malformed, treated as empty desired state
   * (all current resources become DELETE actions).
   */
  desiredSpec: Record<string, unknown>;
  currentResources: CurrentResource[];
}

// ── Service ──────────────────────────────────────────────────

@Injectable()
export class ProvisioningPlannerService {
  plan(input: PlannerInput): ProvisioningPlan {
    const desired = extractDesiredResources(input.desiredSpec);
    const actions: PlanAction[] = [];
    // Track which current resources were matched so unmatched → DELETE
    const matched = new Set<string>();

    for (const d of desired) {
      const curr = input.currentResources.find(
        (r) =>
          r.type.toUpperCase() === d.type.toUpperCase() &&
          r.name === d.name,
      );

      if (!curr) {
        actions.push({
          action: 'CREATE',
          resourceType: d.type,
          resourceName: d.name,
          reason: 'Resource does not exist in current state',
          desiredSpec: d.spec,
        });
      } else {
        matched.add(resourceKey(curr));
        if (specChanged(curr.desiredSpec, d.spec)) {
          actions.push({
            action: 'UPDATE',
            resourceType: d.type,
            resourceName: d.name,
            reason: 'Desired spec differs from current spec',
            desiredSpec: d.spec,
            currentSpec: curr.desiredSpec,
          });
        } else {
          actions.push({
            action: 'NOOP',
            resourceType: d.type,
            resourceName: d.name,
            reason: 'No changes detected',
            desiredSpec: d.spec,
            currentSpec: curr.desiredSpec,
          });
        }
      }
    }

    for (const curr of input.currentResources) {
      if (!matched.has(resourceKey(curr))) {
        actions.push({
          action: 'DELETE',
          resourceType: curr.type,
          resourceName: curr.name,
          reason: 'Resource exists in current state but is absent from desired state',
          currentSpec: curr.desiredSpec,
        });
      }
    }

    return {
      actions,
      summary: {
        create: actions.filter((a) => a.action === 'CREATE').length,
        update: actions.filter((a) => a.action === 'UPDATE').length,
        delete: actions.filter((a) => a.action === 'DELETE').length,
        noop: actions.filter((a) => a.action === 'NOOP').length,
      },
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function resourceKey(r: CurrentResource): string {
  return `${r.type.toUpperCase()}:${r.name}`;
}

function extractDesiredResources(spec: Record<string, unknown>): DesiredResource[] {
  const raw = spec['resources'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (
      item != null &&
      typeof item === 'object' &&
      typeof (item as any).type === 'string' &&
      typeof (item as any).name === 'string'
    ) {
      return [
        {
          type: (item as any).type as string,
          name: (item as any).name as string,
          spec: ((item as any).spec ?? {}) as Record<string, unknown>,
        },
      ];
    }
    return [];
  });
}

// Deterministic deep-equality via sorted-key JSON serialisation.
function specChanged(current: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  return sortedJson(current) !== sortedJson(desired);
}

function sortedJson(val: unknown): string {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(sortedJson).join(',') + ']';
  const keys = Object.keys(val as object).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + sortedJson((val as Record<string, unknown>)[k])).join(',') + '}';
}
