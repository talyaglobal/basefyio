import { Injectable, BadRequestException } from '@nestjs/common';
import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import type {
  IProvisioningProvider,
  ProvisioningExecuteInput,
  ProvisioningExecuteResult,
  ProviderPlan,
} from '../interfaces/provisioning-provider.interface';
import type { ProviderCapability } from '../dto/provider-capability.dto';
import { DockerDesiredSpec } from '../dto/docker-desired-spec.dto';
import type { DockerClientInterface } from './docker-client';
import { DockerCliClient } from './docker-client';

@Injectable()
export class DockerProvisioningProvider implements IProvisioningProvider {
  constructor(
    private readonly docker: DockerClientInterface = new DockerCliClient(),
  ) {}

  getCapabilities(): ProviderCapability {
    return {
      name: 'docker',
      displayName: 'Docker',
      regions: ['local'],
      resourceTypes: ['container'],
      supportedResources: [
        { type: 'container', description: 'Docker container instances' },
      ],
      supportsCreate: true,
      supportsUpdate: true,
      supportsRollback: true,
      supportsDryRun: true,
    };
  }

  plan(input: ProvisioningExecuteInput): ProviderPlan {
    const spec = input.desiredSpec as DockerDesiredSpec;
    if (!spec?.image) {
      return {
        actions: [],
        validationErrors: ['desiredSpec.image is required'],
      };
    }

    const currentContainer = input.currentResources.find(
      (r) => r.type.toLowerCase() === 'container',
    );

    if (currentContainer?.externalId) {
      return {
        actions: [
          {
            action: 'DELETE',
            resourceType: 'container',
            resourceName: currentContainer.name,
            reason: 'Replace existing container with updated spec',
            currentSpec: currentContainer.desiredSpec,
            providerMeta: { externalId: currentContainer.externalId },
          },
          {
            action: 'CREATE',
            resourceType: 'container',
            resourceName: spec.containerName ?? 'docker-container',
            reason: 'Create container from desired spec',
            desiredSpec: spec as unknown as Record<string, unknown>,
          },
        ],
        validationErrors: [],
      };
    }

    return {
      actions: [
        {
          action: 'CREATE',
          resourceType: 'container',
          resourceName: spec.containerName ?? 'docker-container',
          reason: 'Create container from desired spec',
          desiredSpec: spec as unknown as Record<string, unknown>,
        },
      ],
      validationErrors: [],
    };
  }

  async apply(input: ProvisioningExecuteInput): Promise<ProvisioningExecuteResult> {
    await this.validateSpec(input.desiredSpec);

    if (input.dryRun) {
      return {
        success: true,
        resources: [],
        deletedExternalIds: [],
        metadata: { dryRun: true, plan: this.plan(input) },
      };
    }

    const spec = input.desiredSpec as DockerDesiredSpec;
    const containerName = spec.containerName ?? `basefyio-${input.operationId.slice(0, 8)}`;
    const envArray = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);

    const { containerId } = await this.docker.runContainer({
      image: spec.image,
      name: containerName,
      ports: spec.ports,
      env: envArray,
      labels: spec.labels,
    });

    return {
      success: true,
      resources: [
        {
          externalId: containerId,
          type: 'container',
          name: containerName,
          desiredSpec: spec as unknown as Record<string, unknown>,
          actualSpec: { image: spec.image, name: containerName },
          status: 'ACTIVE',
        },
      ],
      deletedExternalIds: [],
      metadata: { containerName },
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    const healthy = await this.docker.isAvailable();
    return { healthy, latencyMs: Date.now() - start };
  }

  private async validateSpec(spec: unknown): Promise<void> {
    const obj = plainToClass(DockerDesiredSpec, spec ?? {});
    const errors = await validate(obj, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) {
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      throw new BadRequestException(`Invalid desiredSpec: ${messages.join('; ')}`);
    }
  }
}
