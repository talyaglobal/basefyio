import { Injectable } from '@nestjs/common';
import {
  IProvisioningProvider,
  ProviderPlan,
  ProviderPlanAction,
  ProvisioningExecuteInput,
  ProvisioningExecuteResult,
} from '../interfaces/provisioning-provider.interface';
import {
  ProvisioningPlannerService,
  PlanAction,
} from '../provisioning-planner.service';

/**
 * Hetzner Cloud provider — Phase 8: dry-run only.
 *
 * Maps generic planner actions to Hetzner resource vocabulary.
 * No real API calls are made; the credential reference is present in the
 * input but intentionally not used until Phase 9 (real apply).
 *
 * Secret boundary: credentialOpenbaoPath is never logged, stored in result,
 * or forwarded to any external system in this phase.
 */

// Supported Hetzner resource kinds (lowercase normalised)
const SUPPORTED_KINDS = new Set(['server', 'volume', 'network', 'firewall', 'ssh_key']);

@Injectable()
export class HetznerProvisioningProvider implements IProvisioningProvider {
  constructor(private readonly planner: ProvisioningPlannerService) {}

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
        providerMeta: this.buildProviderMeta(kind, action),
      });
    }

    return { actions, validationErrors };
  }

  async apply(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult> {
    // Phase 8: dry-run only — no Hetzner API calls.
    // credentialOpenbaoPath is intentionally unused here; it is present in input
    // to satisfy the contract but must not appear in the result or logs.
    const providerPlan = this.plan(input);

    return {
      success: true,
      resources: [],   // dry-run: no resources created or modified
      metadata: {
        provider: 'hetzner',
        dryRun: true,
        actions: providerPlan.actions,
        validationErrors: providerPlan.validationErrors,
      },
    };
  }

  // ── Internal helpers ─────────────────────────────────────────

  private buildProviderMeta(kind: string, action: PlanAction): Record<string, unknown> {
    if (action.action !== 'UPDATE' || !action.desiredSpec || !action.currentSpec) {
      return {};
    }
    return { hetznerAction: classifyUpdateAction(kind, action.desiredSpec, action.currentSpec) };
  }
}

/**
 * Classify the Hetzner sub-action for UPDATE operations.
 * Returns the most specific Hetzner API action name applicable to the spec diff.
 * Falls back to generic 'update' when no specific action is identifiable.
 */
function classifyUpdateAction(
  kind: string,
  desired: Record<string, unknown>,
  current: Record<string, unknown>,
): string {
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
