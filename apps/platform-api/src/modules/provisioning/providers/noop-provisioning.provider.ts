import { Injectable } from '@nestjs/common';
import {
  IProvisioningProvider,
  ProviderPlan,
  ProvisioningExecuteInput,
  ProvisioningExecuteResult,
} from '../interfaces/provisioning-provider.interface';

/** No-op provider for local/test environments. Returns no resources and performs no I/O. */
@Injectable()
export class NoopProvisioningProvider implements IProvisioningProvider {
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
}
