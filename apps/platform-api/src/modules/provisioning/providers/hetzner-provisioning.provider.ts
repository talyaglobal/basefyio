import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  IProvisioningProvider,
  ProviderPlan,
  ProviderPlanAction,
  UpdateStrategy,
  ProvisioningExecuteInput,
  ProvisioningExecuteResult,
} from '../interfaces/provisioning-provider.interface';
import {
  HETZNER_TOKEN_RESOLVER,
  IHetznerTokenResolver,
} from '../interfaces/hetzner-token-resolver.interface';
import {
  ProvisioningPlannerService,
  PlanAction,
} from '../provisioning-planner.service';

/**
 * Hetzner Cloud provider.
 *
 * Phase 8: dry-run only (no API calls).
 * Phase 9a: secret resolver contract wired; token resolved for real operations.
 * Phase 9b+: real Hetzner API calls via HetznerClient.
 *
 * Secret boundary:
 * - credentialOpenbaoPath is passed to the token resolver; the resolved token
 *   is used only inside apply() and is never stored, returned, or logged.
 * - dry-run calls skip resolution entirely.
 */

const SUPPORTED_KINDS = new Set(['server', 'volume', 'network', 'firewall', 'ssh_key']);

@Injectable()
export class HetznerProvisioningProvider implements IProvisioningProvider {
  constructor(
    private readonly planner: ProvisioningPlannerService,
    @Optional()
    @Inject(HETZNER_TOKEN_RESOLVER)
    private readonly tokenResolver?: IHetznerTokenResolver,
  ) {}

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
      });
    }

    return { actions, validationErrors };
  }

  async apply(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult> {
    const isDryRun = input.dryRun ?? false;
    const providerPlan = this.plan(input);

    if (!isDryRun) {
      // Secret resolution: only for real (non-dry-run) operations.
      // The resolved token lives only in this scope — never returned or logged.
      if (!this.tokenResolver) {
        throw new Error(
          'HetznerProvider: tokenResolver is required for non-dry-run operations (wire HETZNER_TOKEN_RESOLVER)',
        );
      }
      // Fail-fast: throws if path is empty, vault is unreachable, or token field missing.
      // The token is used only here; Phase 9b will pass it to HetznerClient.
      const _token = await this.tokenResolver.resolve(input.credentialOpenbaoPath);
      void _token; // Phase 9b: new HetznerClient(_token).apply(providerPlan)
    }

    return {
      success: true,
      resources: [],   // Phase 9b: populated with created/updated resource rows
      metadata: {
        provider: 'hetzner',
        dryRun: isDryRun,
        actions: providerPlan.actions,
        validationErrors: providerPlan.validationErrors,
      },
    };
  }

  // ── Internal helpers ─────────────────────────────────────────

  private resolveUpdateStrategy(kind: string, action: PlanAction): UpdateStrategy | undefined {
    if (action.action !== 'UPDATE' || !action.desiredSpec || !action.currentSpec) {
      return undefined;
    }
    return classifyUpdateAction(kind, action.desiredSpec, action.currentSpec);
  }
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
