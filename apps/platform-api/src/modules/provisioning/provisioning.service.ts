import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type ProvisioningProject, type ProvisioningOperation } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProvisioningProjectDto } from './dto/create-provisioning-project.dto';
import { CreateProvisioningOperationDto } from './dto/create-provisioning-operation.dto';

// ── Response types ────────────────────────────────────────

export interface ProvisioningProjectCreateResponse {
  provisioningProjectId: string;
  provider: string;
  status: string;
  operation: {
    provisioningOperationId: string;
    status: string;
    dryRun: boolean;
    idempotent: boolean;
  };
}

function toProvisioningProjectCreateResponse(
  pp: ProvisioningProject,
  op: ProvisioningOperation,
  idempotent: boolean,
): ProvisioningProjectCreateResponse {
  return {
    provisioningProjectId: pp.id,
    provider: pp.provider,
    status: pp.status,
    operation: {
      provisioningOperationId: op.id,
      status: op.status,
      dryRun: op.dryRun,
      idempotent,
    },
  };
}

// ── Internal types ────────────────────────────────────────

type EventKind =
  | 'STATUS_CHANGED'
  | 'OPERATION_STARTED'
  | 'OPERATION_COMPLETED'
  | 'OPERATION_FAILED'
  | 'DRY_RUN_COMPLETED'
  | 'ROLLBACK_INITIATED'
  | 'ROLLBACK_COMPLETED'
  | 'CREDENTIAL_ROTATED'
  | 'RESOURCE_CREATED'
  | 'RESOURCE_UPDATED'
  | 'RESOURCE_DESTROYED';

type PrismaTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

// ── Service ───────────────────────────────────────────────

@Injectable()
export class ProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Ownership guards ──────────────────────────────────────

  private async resolveProvisioningProject(id: string) {
    const pp = await this.prisma.provisioningProject.findUnique({
      where: { id },
      include: { project: { select: { teamId: true } } },
    });
    if (!pp) throw new NotFoundException('Provisioning project not found');
    return pp;
  }

  private async assertTeamMember(teamId: string, userId: string): Promise<void> {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
  }

  private async assertProvisioningProjectAccess(
    provisioningProjectId: string,
    userId: string,
  ) {
    const pp = await this.resolveProvisioningProject(provisioningProjectId);
    await this.assertTeamMember(pp.project.teamId, userId);
    return pp;
  }

  // ── Audit ─────────────────────────────────────────────────

  private writeAuditEvent(
    tx: PrismaTx,
    data: {
      provisioningProjectId: string;
      resourceId?: string | null;
      operationId?: string | null;
      kind: EventKind;
      actorUserId?: string | null;
      fromStatus?: string | null;
      toStatus?: string | null;
      detail?: unknown;
    },
  ): Promise<void> {
    return tx.provisioningAuditEvent
      .create({
        data: {
          provisioningProjectId: data.provisioningProjectId,
          resourceId: data.resourceId ?? undefined,
          operationId: data.operationId ?? undefined,
          kind: data.kind,
          actorUserId: data.actorUserId ?? undefined,
          fromStatus: data.fromStatus ?? undefined,
          toStatus: data.toStatus ?? undefined,
          detail: (data.detail as any) ?? undefined,
        },
      })
      .then(() => undefined);
  }

  // ── Projects ──────────────────────────────────────────────

  async createProject(
    userId: string,
    dto: CreateProvisioningProjectDto,
  ): Promise<ProvisioningProjectCreateResponse> {
    // 1. Resolve platform project → teamId
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    // 2. Assert team membership
    await this.assertTeamMember(project.teamId, userId);

    // 3. Validate credential ref — team scope + not revoked
    const cred = await this.prisma.provisioningCredentialRef.findUnique({
      where: { id: dto.credentialRefId },
      select: { teamId: true, revokedAt: true },
    });
    if (!cred) throw new NotFoundException('Credential reference not found');
    if (cred.teamId !== project.teamId)
      throw new ForbiddenException('Credential reference does not belong to this team');
    if (cred.revokedAt)
      throw new ConflictException('Credential reference has been revoked');

    // 4. Idempotency — check for existing project + operation with this key
    const existingProject = await this.prisma.provisioningProject.findUnique({
      where: { projectId: dto.projectId },
    });

    if (existingProject) {
      const existingOp = await this.prisma.provisioningOperation.findUnique({
        where: {
          provisioningProjectId_idempotencyKey: {
            provisioningProjectId: existingProject.id,
            idempotencyKey: dto.idempotencyKey,
          },
        },
      });
      if (existingOp) {
        // Same projectId + same idempotencyKey → idempotent replay, no writes
        return toProvisioningProjectCreateResponse(existingProject, existingOp, true);
      }
      // Different key — project already created, direct caller to /operations
      throw new ConflictException(
        'A provisioning project already exists for this platform project. ' +
          'Submit further operations via POST /v1/provisioning/operations.',
      );
    }

    // 5. Atomic create: project + operation + first audit event
    const opStatus = dto.dryRun ? 'DRY_RUN' : 'PENDING';
    const now = new Date();

    const [pp, op] = await this.prisma.$transaction(async (tx) => {
      const pp = await tx.provisioningProject.create({
        data: {
          projectId: dto.projectId,
          provider: dto.provider ?? 'hetzner',
          region: dto.region,
          datacenter: dto.datacenter,
          credentialRefId: dto.credentialRefId,
          desiredState: dto.desiredSpec as any,
          status: 'PENDING',
        },
      });

      const op = await tx.provisioningOperation.create({
        data: {
          provisioningProjectId: pp.id,
          type: 'CREATE',
          status: opStatus,
          dryRun: dto.dryRun,
          idempotencyKey: dto.idempotencyKey,
          requestedBy: userId,
          input: dto.desiredSpec as any,
          startedAt: dto.dryRun ? now : undefined,
          completedAt: dto.dryRun ? now : undefined,
        },
      });

      await this.writeAuditEvent(tx, {
        provisioningProjectId: pp.id,
        operationId: op.id,
        kind: dto.dryRun ? 'DRY_RUN_COMPLETED' : 'STATUS_CHANGED',
        actorUserId: userId,
        fromStatus: null,
        toStatus: opStatus,
        detail: dto.dryRun ? { dryRun: true } : undefined,
      });

      return [pp, op] as const;
    });

    return toProvisioningProjectCreateResponse(pp, op, false);
  }

  // ── Operations ────────────────────────────────────────────

  async createOperation(
    userId: string,
    dto: CreateProvisioningOperationDto,
  ) {
    await this.assertProvisioningProjectAccess(dto.provisioningProjectId, userId);

    // Idempotency: return existing operation without error if key already seen
    const existing = await this.prisma.provisioningOperation.findUnique({
      where: {
        provisioningProjectId_idempotencyKey: {
          provisioningProjectId: dto.provisioningProjectId,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existing) return { operation: existing, idempotent: true };

    const initialStatus = dto.dryRun ? 'DRY_RUN' : 'PENDING';

    const op = await this.prisma.$transaction(async (tx) => {
      const op = await tx.provisioningOperation.create({
        data: {
          provisioningProjectId: dto.provisioningProjectId,
          resourceId: dto.resourceId,
          type: dto.type,
          status: initialStatus,
          dryRun: dto.dryRun,
          idempotencyKey: dto.idempotencyKey,
          requestedBy: userId,
          input: (dto.input as any) ?? undefined,
          startedAt: dto.dryRun ? new Date() : undefined,
          completedAt: dto.dryRun ? new Date() : undefined,
        },
      });

      await this.writeAuditEvent(tx, {
        provisioningProjectId: dto.provisioningProjectId,
        resourceId: dto.resourceId,
        operationId: op.id,
        kind: dto.dryRun ? 'DRY_RUN_COMPLETED' : 'OPERATION_STARTED',
        actorUserId: userId,
        fromStatus: null,
        toStatus: initialStatus,
        detail: dto.dryRun ? { dryRun: true } : undefined,
      });

      if (dto.type === 'ROLLBACK' && !dto.dryRun) {
        await this.writeAuditEvent(tx, {
          provisioningProjectId: dto.provisioningProjectId,
          resourceId: dto.resourceId,
          operationId: op.id,
          kind: 'ROLLBACK_INITIATED',
          actorUserId: userId,
        });
      }

      return op;
    });

    return { operation: op, idempotent: false };
  }

  // ── Read endpoints ────────────────────────────────────────

  async getOperation(userId: string, operationId: string) {
    const op = await this.prisma.provisioningOperation.findUnique({
      where: { id: operationId },
    });
    if (!op) throw new NotFoundException('Operation not found');
    await this.assertProvisioningProjectAccess(op.provisioningProjectId, userId);
    return op;
  }

  async listResources(userId: string, provisioningProjectId: string) {
    await this.assertProvisioningProjectAccess(provisioningProjectId, userId);
    return this.prisma.provisioningResource.findMany({
      where: { provisioningProjectId },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        provisioningProjectId: true,
        kind: true,
        name: true,
        status: true,
        region: true,
        datacenter: true,
        externalId: true,
        desiredSpec: true,
        actualSpec: true,
        lastSyncedAt: true,
        destroyedAt: true,
        createdAt: true,
        updatedAt: true,
        // rollbackSpec excluded — sensitive operational data
      },
    });
  }
}
