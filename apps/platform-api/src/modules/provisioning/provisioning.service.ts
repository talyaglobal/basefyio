import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProvisioningProjectDto } from './dto/create-provisioning-project.dto';
import { CreateProvisioningOperationDto } from './dto/create-provisioning-operation.dto';

// Typed subset of Prisma enum values used inline — keeps import surface minimal
// until the Prisma/Drizzle ownership is reconciled (see README.md).
type EventKind =
  | 'STATUS_CHANGED'
  | 'OPERATION_STARTED'
  | 'OPERATION_COMPLETED'
  | 'OPERATION_FAILED'
  | 'DRY_RUN_COMPLETED'
  | 'ROLLBACK_INITIATED';

@Injectable()
export class ProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Ownership ───────────────────────────────────────────────

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

  // ── Audit ────────────────────────────────────────────────────

  private writeAuditEvent(data: {
    provisioningProjectId: string;
    resourceId?: string | null;
    operationId?: string | null;
    kind: EventKind;
    actorUserId?: string | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    detail?: unknown;
  }): Promise<void> {
    return this.prisma.provisioningAuditEvent
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

  // ── Projects ────────────────────────────────────────────────

  async createProject(
    userId: string,
    dto: CreateProvisioningProjectDto,
  ) {
    // Resolve the basefyio project and assert team membership
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);

    // Ensure the credential ref belongs to the same team
    const cred = await this.prisma.provisioningCredentialRef.findUnique({
      where: { id: dto.credentialRefId },
      select: { teamId: true, revokedAt: true },
    });
    if (!cred) throw new NotFoundException('Credential reference not found');
    if (cred.teamId !== project.teamId)
      throw new ForbiddenException('Credential reference does not belong to this team');
    if (cred.revokedAt)
      throw new ConflictException('Credential reference has been revoked');

    // One ProvisioningProject per basefyio project
    const existing = await this.prisma.provisioningProject.findUnique({
      where: { projectId: dto.projectId },
    });
    if (existing)
      throw new ConflictException('A provisioning project already exists for this project');

    const pp = await this.prisma.provisioningProject.create({
      data: {
        projectId: dto.projectId,
        region: dto.region,
        datacenter: dto.datacenter,
        provider: dto.provider ?? 'hetzner',
        credentialRefId: dto.credentialRefId,
        status: 'PENDING',
      },
    });

    await this.writeAuditEvent({
      provisioningProjectId: pp.id,
      kind: 'STATUS_CHANGED',
      actorUserId: userId,
      fromStatus: null,
      toStatus: 'PENDING',
    });

    return pp;
  }

  // ── Operations ──────────────────────────────────────────────

  async createOperation(
    userId: string,
    dto: CreateProvisioningOperationDto,
  ) {
    const pp = await this.assertProvisioningProjectAccess(
      dto.provisioningProjectId,
      userId,
    );

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

    // dryRun=true → immediately terminal (DRY_RUN); no executor queued
    const initialStatus = dto.dryRun ? 'DRY_RUN' : 'PENDING';

    const op = await this.prisma.provisioningOperation.create({
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

    const auditKind: EventKind = dto.dryRun
      ? 'DRY_RUN_COMPLETED'
      : 'OPERATION_STARTED';

    await this.writeAuditEvent({
      provisioningProjectId: dto.provisioningProjectId,
      resourceId: dto.resourceId,
      operationId: op.id,
      kind: auditKind,
      actorUserId: userId,
      fromStatus: null,
      toStatus: initialStatus,
      detail: dto.dryRun ? { dryRun: true } : undefined,
    });

    // If this is a ROLLBACK type, also emit a ROLLBACK_INITIATED event
    if (dto.type === 'ROLLBACK' && !dto.dryRun) {
      await this.writeAuditEvent({
        provisioningProjectId: dto.provisioningProjectId,
        resourceId: dto.resourceId,
        operationId: op.id,
        kind: 'ROLLBACK_INITIATED',
        actorUserId: userId,
      });
    }

    return { operation: op, idempotent: false };
  }

  async getOperation(userId: string, operationId: string) {
    const op = await this.prisma.provisioningOperation.findUnique({
      where: { id: operationId },
    });
    if (!op) throw new NotFoundException('Operation not found');
    await this.assertProvisioningProjectAccess(op.provisioningProjectId, userId);
    return op;
  }

  // ── Resources ───────────────────────────────────────────────

  async listResources(userId: string, provisioningProjectId: string) {
    await this.assertProvisioningProjectAccess(provisioningProjectId, userId);
    // Read from DB only — no provider calls.
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
        // rollbackSpec excluded from list response (sensitive operational data)
      },
    });
  }
}
