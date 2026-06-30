import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProvisioningResourceResult } from './interfaces/provisioning-provider.interface';

type ResourceAuditKind = 'RESOURCE_CREATED' | 'RESOURCE_UPDATED' | 'RESOURCE_DESTROYED';

export interface ProjectionParams {
  operationId: string;
  provisioningProjectId: string;
  region: string;
  datacenter: string | null;
  resources: ProvisioningResourceResult[];
  /** External IDs of resources the provider deleted. Projection marks them DESTROYED. */
  deletedExternalIds?: string[];
  actorUserId: string;
}

@Injectable()
export class ProvisioningResourceProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async project(params: ProjectionParams): Promise<void> {
    for (const resource of params.resources) {
      const existing = await this.findExisting(params.provisioningProjectId, resource);
      if (existing) {
        await this.updateResource(existing, resource, params.operationId, params.actorUserId);
      } else {
        await this.createResource(params, resource);
      }
    }
    if (params.deletedExternalIds?.length) {
      await this.destroyResources(params, params.deletedExternalIds);
    }
  }

  // ── Matching ────────────────────────────────────────────────

  private async findExisting(provisioningProjectId: string, resource: ProvisioningResourceResult) {
    // Prefer provider-assigned ID — most precise match
    const byExternalId = await this.prisma.provisioningResource.findFirst({
      where: { provisioningProjectId, externalId: resource.externalId },
    });
    if (byExternalId) return byExternalId;

    // Fall back to logical identity (kind + name) for resources not yet assigned an externalId
    return this.prisma.provisioningResource.findFirst({
      where: {
        provisioningProjectId,
        kind: resource.type.toUpperCase() as any,
        name: resource.name,
      },
    });
  }

  // ── Create ──────────────────────────────────────────────────

  private async createResource(params: ProjectionParams, resource: ProvisioningResourceResult): Promise<void> {
    const created = await this.prisma.provisioningResource.create({
      data: {
        provisioningProjectId: params.provisioningProjectId,
        kind: resource.type.toUpperCase() as any,
        name: resource.name,
        status: 'ACTIVE',
        region: params.region,
        datacenter: params.datacenter ?? undefined,
        externalId: resource.externalId,
        desiredSpec: resource.desiredSpec as any,
        actualSpec: resource.actualSpec as any,
        // rollbackSpec is null on first creation — nothing to roll back to yet
        lastSyncedAt: new Date(),
      },
    });

    await this.writeAuditEvent({
      provisioningProjectId: params.provisioningProjectId,
      resourceId: created.id,
      operationId: params.operationId,
      kind: 'RESOURCE_CREATED',
      actorUserId: params.actorUserId,
      fromStatus: null,
      toStatus: 'ACTIVE',
    });
  }

  // ── Update ──────────────────────────────────────────────────

  private async updateResource(
    existing: { id: string; provisioningProjectId: string; status: string; desiredSpec: unknown },
    resource: ProvisioningResourceResult,
    operationId: string,
    actorUserId: string,
  ): Promise<void> {
    // Snapshot desiredSpec before overwriting so ROLLBACK operations can restore it
    await this.prisma.provisioningResource.update({
      where: { id: existing.id },
      data: {
        externalId: resource.externalId,
        status: 'ACTIVE',
        desiredSpec: resource.desiredSpec as any,
        actualSpec: resource.actualSpec as any,
        rollbackSpec: existing.desiredSpec as any,
        lastSyncedAt: new Date(),
      },
    });

    await this.writeAuditEvent({
      provisioningProjectId: existing.provisioningProjectId,
      resourceId: existing.id,
      operationId,
      kind: 'RESOURCE_UPDATED',
      actorUserId,
      fromStatus: existing.status,
      toStatus: 'ACTIVE',
    });
  }

  // ── Destroy ─────────────────────────────────────────────────

  private async destroyResources(params: ProjectionParams, externalIds: string[]): Promise<void> {
    for (const externalId of externalIds) {
      const resource = await this.prisma.provisioningResource.findFirst({
        where: { provisioningProjectId: params.provisioningProjectId, externalId, destroyedAt: null },
      });
      if (!resource) continue; // already destroyed or never tracked — idempotent

      await this.prisma.provisioningResource.update({
        where: { id: resource.id },
        data: { status: 'DESTROYED' as any, destroyedAt: new Date() },
      });

      await this.writeAuditEvent({
        provisioningProjectId: params.provisioningProjectId,
        resourceId: resource.id,
        operationId: params.operationId,
        kind: 'RESOURCE_DESTROYED',
        actorUserId: params.actorUserId,
        fromStatus: resource.status,
        toStatus: 'DESTROYED',
      });
    }
  }

  // ── Audit ────────────────────────────────────────────────────

  private writeAuditEvent(data: {
    provisioningProjectId: string;
    resourceId: string;
    operationId: string;
    kind: ResourceAuditKind;
    actorUserId: string;
    fromStatus: string | null;
    toStatus: string;
  }): Promise<void> {
    return this.prisma.provisioningAuditEvent
      .create({
        data: {
          provisioningProjectId: data.provisioningProjectId,
          resourceId: data.resourceId,
          operationId: data.operationId,
          kind: data.kind,
          actorUserId: data.actorUserId,
          fromStatus: data.fromStatus ?? undefined,
          toStatus: data.toStatus,
        },
      })
      .then(() => undefined);
  }
}
