import { Injectable } from '@nestjs/common';
import {
  IProvisioningProvider,
  ProvisioningExecuteInput,
  ProvisioningExecuteResult,
} from '../interfaces/provisioning-provider.interface';

@Injectable()
export class NoopProvisioningProvider implements IProvisioningProvider {
  async execute(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult> {
    return { success: true, result: { noop: true, operationId: input.operationId } };
  }
}
