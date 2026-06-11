import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import {
  IProvisioningProvider,
  ProviderCurrentResource,
  ProviderPlan,
  ProviderPlanAction,
  UpdateStrategy,
  ProvisioningExecuteInput,
  ProvisioningExecuteResult,
  ProvisioningResourceResult,
} from '../interfaces/provisioning-provider.interface';
import { ProviderCapability } from '../dto/provider-capability.dto';
import {
  HETZNER_TOKEN_RESOLVER,
  IHetznerTokenResolver,
} from '../interfaces/hetzner-token-resolver.interface';
import {
  HETZNER_CLIENT,
  IHetznerClient,
} from './hetzner/hetzner-client.interface';
import { HetznerLocationMapper } from './hetzner/hetzner-location.mapper';
import {
  ProvisioningPlannerService,
  PlanAction,
} from '../provisioning-planner.service';
import { topoSort } from '../provisioning-topo-sort';
import { PartialApplyError, FailedActionRecord } from '../interfaces/partial-apply.error';
import { HetznerDesiredSpec } from '../dto/hetzner-desired-spec.dto';

/**
 * Hetzner Cloud provider.
 *
 * Phase 8:  dry-run only (no API calls).
 * Phase 9:  real apply — tokenResolver resolves OpenBao secret; client dispatches
 *           CREATE/UPDATE/DELETE to Hetzner API.
 *
 * Secret boundary:
 * - credentialOpenbaoPath is passed to tokenResolver; the resolved token lives only
 *   inside apply() and is never stored, returned, logged, or included in metadata.
 * - dryRun=true skips both resolution and API calls entirely.
 */

const SUPPORTED_KINDS = new Set(['server', 'volume', 'network', 'firewall', 'ssh_key']);

@Injectable()
export class HetznerProvisioningProvider implements IProvisioningProvider {
  constructor(
    private readonly planner: ProvisioningPlannerService,
    @Optional()
    @Inject(HETZNER_TOKEN_RESOLVER)
    private readonly tokenResolver?: IHetznerTokenResolver,
    @Optional()
    @Inject(HETZNER_CLIENT)
    private readonly client?: IHetznerClient,
  ) {}

  // ── getCapabilities() ────────────────────────────────────────

  getCapabilities(): ProviderCapability {
    return {
      name: 'hetzner',
      displayName: 'Hetzner Cloud',
      regions: ['eu-central', 'us-east', 'ap-southeast'],
      resourceTypes: ['server', 'network', 'loadbalancer', 'volume'],
    };
  }

  // ── plan() ───────────────────────────────────────────────────

  plan(input: ProvisioningExecuteInput): ProviderPlan {
    const genericPlan = this.planner.plan({
      projectId: input.projectId,
      provider: input.providerType,
      region: input.region,
      datacenter: input.datacenter,
      desiredSpec: (input.desiredSpec as Record<string, unknown>) ?? {},
      currentResources: input.currentResources,
    });

    const actions: ProviderPlanAction[] = [];
    const validationErrors: string[] = [];

    for (const action of genericPlan.actions) {
      const kind = action.resourceType.toLowerCase();
      if (!SUPPORTED_KINDS.has(kind)) {
        validationErrors.push(
          `Unsupported resource kind '${action.resourceType}' for provider hetzner. ` +
            `Supported kinds: ${[...SUPPORTED_KINDS].join(', ')}.`,
        );
        continue;
      }
      actions.push({
        action: action.action,
        resourceType: kind,
        resourceName: action.resourceName,
        reason: action.reason,
        desiredSpec: action.desiredSpec,
        currentSpec: action.currentSpec,
        updateStrategy: this.resolveUpdateStrategy(kind, action),
        dependencies: action.dependencies,
      });
    }

    return { actions, validationErrors };
  }

  // ── validateSpec() ────────────────────────────────────────────

  private async validateSpec(spec: unknown): Promise<void> {
    const obj = plainToClass(HetznerDesiredSpec, spec ?? {});
    const errors = await validate(obj, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) {
      const messages = errors.flatMap(e => Object.values(e.constraints ?? {}));
      throw new BadRequestException(`Invalid desiredSpec: ${messages.join('; ')}`);
    }
  }

  // ── healthCheck() ─────────────────────────────────────────────

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      // In a real implementation, this would call the Hetzner API status endpoint.
      // For now, return healthy if provider is instantiated.
      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  // ── apply() ──────────────────────────────────────────────────

  async apply(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult> {
    await this.validateSpec(input.desiredSpec);
    const isDryRun = input.dryRun ?? false;
    const providerPlan = this.plan(input);

    if (isDryRun) {
      return {
        success: true,
        resources: [],
        metadata: {
          provider: 'hetzner',
          dryRun: true,
          actions: topoSort(providerPlan.actions),
          validationErrors: providerPlan.validationErrors,
        },
      };
    }

    // Real apply: both dependencies required
    if (!this.tokenResolver) {
      throw new Error(
        'HetznerProvider: HETZNER_TOKEN_RESOLVER is required for real operations',
      );
    }
    if (!this.client) {
      throw new Error(
        'HetznerProvider: HETZNER_CLIENT is required for real operations',
      );
    }

    // Resolve secret — lives only in this scope; never stored, returned, or logged
    const apiToken = await this.tokenResolver.resolve(input.credentialOpenbaoPath);
    const location = HetznerLocationMapper.resolve(input.region, input.datacenter);

    const resources: ProvisioningResourceResult[] = [];
    const deletedExternalIds: string[] = [];
    const failures: FailedActionRecord[] = [];

    // topoSort may throw CircularDependencyError — that propagates before any dispatch.
    const sortedActions = topoSort(providerPlan.actions);

    for (const action of sortedActions) {
      if (action.action === 'NOOP') continue;

      try {
        if (action.action === 'CREATE') {
          resources.push(
            await this.dispatchCreate(action, location, apiToken),
          );
        } else if (action.action === 'UPDATE') {
          resources.push(
            await this.dispatchUpdate(action, input.currentResources, apiToken),
          );
        } else if (action.action === 'DELETE') {
          const externalId = requireExternalId(action, input.currentResources);
          await this.dispatchDelete(action.resourceType, externalId, apiToken);
          deletedExternalIds.push(externalId);
        }
      } catch (err) {
        failures.push({
          resourceType: action.resourceType,
          resourceName: action.resourceName,
          action: action.action,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failures.length > 0) {
      throw new PartialApplyError(resources, deletedExternalIds, failures);
    }

    return {
      success: true,
      resources,
      deletedExternalIds,
      metadata: { provider: 'hetzner', dryRun: false },
    };
  }

  // ── CREATE dispatch ──────────────────────────────────────────

  private async dispatchCreate(
    action: ProviderPlanAction,
    location: string,
    apiToken: string,
  ): Promise<ProvisioningResourceResult> {
    const spec = (action.desiredSpec ?? {}) as Record<string, unknown>;

    if (action.resourceType === 'server') {
      const created = await this.client!.createServer(
        {
          name: action.resourceName,
          server_type: spec.server_type as string,
          image: spec.image as string,
          location,
          ssh_keys: spec.ssh_keys as string[] | undefined,
          labels: spec.labels as Record<string, string> | undefined,
          user_data: spec.user_data as string | undefined,
        },
        apiToken,
      );
      return {
        externalId: String(created.id),
        type: 'server',
        name: created.name,
        desiredSpec: spec,
        actualSpec: {
          id: created.id,
          server_type: created.serverType,
          public_ipv4: created.publicIpv4,
          location: created.locationName,
          datacenter: created.datacenterName,
          status: created.status,
        },
        status: 'ACTIVE',
      };
    }

    throw new Error(
      `CREATE not yet implemented for kind '${action.resourceType}' (Phase 9 covers server only)`,
    );
  }

  // ── UPDATE dispatch ──────────────────────────────────────────

  private async dispatchUpdate(
    action: ProviderPlanAction,
    currentResources: ProviderCurrentResource[],
    apiToken: string,
  ): Promise<ProvisioningResourceResult> {
    const externalId = requireExternalId(action, currentResources);
    const spec = (action.desiredSpec ?? {}) as Record<string, unknown>;

    if (!action.updateStrategy) {
      throw new Error(
        `UPDATE action for '${action.resourceName}' is missing updateStrategy — ` +
          `this is a provider contract violation`,
      );
    }

    if (action.resourceType === 'server') {
      const serverId = Number(externalId);
      switch (action.updateStrategy) {
        case 'resize':
          await this.client!.resizeServer(serverId, spec.server_type as string, apiToken);
          break;
        case 'rebuild':
          await this.client!.rebuildServer(serverId, spec.image as string, apiToken);
          break;
        default:
          throw new Error(
            `updateStrategy '${action.updateStrategy}' is not applicable to server resources`,
          );
      }
      const snapshot = await this.client!.getServer(serverId, apiToken);
      return {
        externalId,
        type: 'server',
        name: action.resourceName,
        desiredSpec: spec,
        actualSpec: {
          id: snapshot.id,
          server_type: snapshot.serverType,
          public_ipv4: snapshot.publicIpv4,
          location: snapshot.locationName,
          datacenter: snapshot.datacenterName,
          status: snapshot.status,
        },
        status: 'ACTIVE',
      };
    }

    throw new Error(
      `UPDATE not yet implemented for kind '${action.resourceType}' (Phase 9 covers server only)`,
    );
  }

  // ── DELETE dispatch ──────────────────────────────────────────

  private async dispatchDelete(
    resourceType: string,
    externalId: string,
    apiToken: string,
  ): Promise<void> {
    if (resourceType === 'server') {
      await this.client!.deleteServer(Number(externalId), apiToken);
      return;
    }
    throw new Error(
      `DELETE not yet implemented for kind '${resourceType}' (Phase 9 covers server only)`,
    );
  }

  // ── Internal helpers ─────────────────────────────────────────

  private resolveUpdateStrategy(kind: string, action: PlanAction): UpdateStrategy | undefined {
    if (action.action !== 'UPDATE' || !action.desiredSpec || !action.currentSpec) {
      return undefined;
    }
    return classifyUpdateAction(kind, action.desiredSpec, action.currentSpec);
  }
}

// ── Module-level helpers ─────────────────────────────────────

/**
 * Locate the externalId for a resource named in a plan action from the current DB snapshot.
 * Throws if the resource is untracked (no externalId) — DELETE/UPDATE by name is unsafe.
 */
function requireExternalId(
  action: ProviderPlanAction,
  currentResources: ProviderCurrentResource[],
): string {
  const current = currentResources.find(
    (r) =>
      r.type.toLowerCase() === action.resourceType &&
      r.name === action.resourceName,
  );
  if (!current?.externalId) {
    throw new Error(
      `Cannot ${action.action} resource '${action.resourceName}' ` +
        `(kind: ${action.resourceType}): externalId is required but missing. ` +
        `Ensure the resource was tracked after initial creation.`,
    );
  }
  return current.externalId;
}

/**
 * Classify the Hetzner sub-action for UPDATE operations.
 * Falls back to 'update' when no more specific action is identifiable.
 */
function classifyUpdateAction(
  kind: string,
  desired: Record<string, unknown>,
  current: Record<string, unknown>,
): UpdateStrategy {
  if (kind === 'server') {
    if (desired['server_type'] !== current['server_type']) return 'resize';
    if (desired['image'] !== current['image']) return 'rebuild';
  }
  if (kind === 'volume' && desired['size'] !== current['size']) {
    return 'resize';
  }
  if (kind === 'firewall') {
    return 'set_rules';
  }
  return 'update';
}
