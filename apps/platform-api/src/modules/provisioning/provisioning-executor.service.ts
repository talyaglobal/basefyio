import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProviderCurrentResource,
  ProvisioningExecuteInput,
} from './interfaces/provisioning-provider.interface';
import { IProviderRegistry, PROVIDER_REGISTRY } from './interfaces/provider-registry.interface';
import { normalizeProviderError } from './interfaces/provider-error.interface';
import { ProvisioningResourceProjectionService } from './provisioning-resource-projection.service';

type AuditEventKind =
  | 'STATUS_CHANGED'
  | 'OPERATION_COMPLETED'
  | 'OPERATION_FAILED';

@Injectable()
export class ProvisioningExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_REGISTRY) private readonly registry: IProviderRegistry,
    private readonly projection: ProvisioningResourceProjectionService,
  ) {}

  async executeOperation(userId: string, operationId: string) {
    // Load operation with full context needed for ownership, dispatch, and input building
    const op = await this.prisma.provisioningOperation.findUnique({
      where: { id: operationId },
      include: {
        provisioningProject: {
          include: {
            project: { select: { teamId: true, id: true } },
            credentialRef: { select: { openbaoPath: true } },
          },
        },
      },
    });
    if (!op) throw new NotFoundException('Operation not found');

    // Ownership: caller must be a member of the project's team
    const teamId = op.provisioningProject.project.teamId;
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a member of this team');

    // State guard: allowlist — only PENDING may execute.
    if (op.status !== 'PENDING') {
      throw new BadRequestException(
        `Operation is in status ${op.status} and cannot be executed. Only PENDING operations are executable.`,
      );
    }

    // Resolve provider before mutating state — unknown type fails here with 400, not after RUNNING
    const provider = this.registry.resolve(op.provisioningProject.provider);

    // Fetch current resources so the provider can compute a diff plan
    const currentRows = await this.prisma.provisioningResource.findMany({
      where: { provisioningProjectId: op.provisioningProjectId, destroyedAt: null },
      select: { id: true, kind: true, name: true, status: true, desiredSpec: true, actualSpec: true, externalId: true },
    });
    const currentResources: ProviderCurrentResource[] = currentRows.map((r) => ({
      id: r.id,
      type: r.kind,
      name: r.name,
      status: r.status,
      desiredSpec: (r.desiredSpec ?? {}) as Record<string, unknown>,
      actualSpec: (r.actualSpec ?? null) as Record<string, unknown> | null,
      externalId: r.externalId,
    }));

    // Build the full provider input contract — openbao path only, no secret resolution here
    const input: ProvisioningExecuteInput = {
      operationId: op.id,
      projectId: op.provisioningProject.project.id,
      providerType: op.provisioningProject.provider,
      region: op.provisioningProject.region,
      datacenter: op.provisioningProject.datacenter ?? null,
      desiredSpec: op.input,
      credentialOpenbaoPath: op.provisioningProject.credentialRef.openbaoPath,
      currentResources,
    };

    // ── PENDING → RUNNING ──────────────────────────────────────
    await this.prisma.provisioningOperation.update({
      where: { id: op.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await this.writeAuditEvent({
      provisioningProjectId: op.provisioningProjectId,
      operationId: op.id,
      kind: 'STATUS_CHANGED',
      actorUserId: userId,
      fromStatus: 'PENDING',
      toStatus: 'RUNNING',
      detail: { providerType: input.providerType, region: input.region },
    });

    // ── Provider call (separate catch — failure → FAILED, not propagated) ────
    let providerResult;
    try {
      providerResult = await provider.apply(input);
    } catch (err) {
      // Provider error: RUNNING → FAILED; normalized, stored, returned — never re-thrown
      const normalized = normalizeProviderError(err);
      const failed = await this.prisma.provisioningOperation.update({
        where: { id: op.id },
        data: { status: 'FAILED', errorMessage: normalized.message, completedAt: new Date() },
      });
      await this.writeAuditEvent({
        provisioningProjectId: op.provisioningProjectId,
        operationId: op.id,
        kind: 'OPERATION_FAILED',
        actorUserId: userId,
        fromStatus: 'RUNNING',
        toStatus: 'FAILED',
        detail: {
          providerType: input.providerType,
          region: input.region,
          error: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
        },
      });
      return failed;
      // projection is NOT called — no resource mutations from a failed provider call
    }

    // ── Resource projection (before COMPLETED update) ───────────────────────
    // If projection fails, the operation stays RUNNING and can be recovered.
    // A COMPLETED operation with missing resource rows is a harder inconsistency to fix.
    if (providerResult.resources?.length) {
      await this.projection.project({
        operationId: op.id,
        provisioningProjectId: op.provisioningProjectId,
        region: op.provisioningProject.region,
        datacenter: op.provisioningProject.datacenter ?? null,
        resources: providerResult.resources,
        actorUserId: userId,
      });
    }

    // ── RUNNING → COMPLETED (only after projection succeeds) ────────────────
    const completed = await this.prisma.provisioningOperation.update({
      where: { id: op.id },
      data: {
        status: 'COMPLETED',
        result: {
          metadata: providerResult.metadata ?? {},
          resourceCount: providerResult.resources?.length ?? 0,
        } as any,
        completedAt: new Date(),
      },
    });
    await this.writeAuditEvent({
      provisioningProjectId: op.provisioningProjectId,
      operationId: op.id,
      kind: 'OPERATION_COMPLETED',
      actorUserId: userId,
      fromStatus: 'RUNNING',
      toStatus: 'COMPLETED',
      detail: { providerType: input.providerType, region: input.region },
    });
    return completed;
  }

  private writeAuditEvent(data: {
    provisioningProjectId: string;
    operationId: string;
    kind: AuditEventKind;
    actorUserId: string;
    fromStatus: string;
    toStatus: string;
    detail?: unknown;
  }): Promise<void> {
    return this.prisma.provisioningAuditEvent
      .create({
        data: {
          provisioningProjectId: data.provisioningProjectId,
          operationId: data.operationId,
          kind: data.kind,
          actorUserId: data.actorUserId,
          fromStatus: data.fromStatus,
          toStatus: data.toStatus,
          detail: (data.detail as any) ?? undefined,
        },
      })
      .then(() => undefined);
  }
}
