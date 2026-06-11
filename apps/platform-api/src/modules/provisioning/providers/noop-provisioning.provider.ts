import { Injectable } from '@nestjs/common';
import {
  IProvisioningProvider,
  ProviderPlan,
  ProvisioningExecuteInput,
  ProvisioningExecuteResult,
} from '../interfaces/provisioning-provider.interface';
import { ProviderCapability } from '../dto/provider-capability.dto';

/** No-op provider for local/test environments. Returns no resources and performs no I/O. */
@Injectable()
export class NoopProvisioningProvider implements IProvisioningProvider {
  getCapabilities(): ProviderCapability {
    return {
      name: 'noop',
      displayName: 'No-op (testing)',
      regions: [],
      resourceTypes: [],
      supportedResources: [],
      supportsCreate: true,
      supportsUpdate: true,
      supportsRollback: true,
      supportsDryRun: true,
    };
  }

  plan(_input: ProvisioningExecuteInput): ProviderPlan {
    return { actions: [], validationErrors: [] };
  }

  async apply(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult> {
    return {
      success: true,
      resources: [],
      metadata: { noop: true, operationId: input.operationId },
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    return { healthy: true, latencyMs: 0 };
  }
}
