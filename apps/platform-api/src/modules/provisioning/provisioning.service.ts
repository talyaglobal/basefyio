import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type ProvisioningProject, type ProvisioningOperation } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProvisioningProjectDto } from './dto/create-provisioning-project.dto';
import { CreateProvisioningOperationDto } from './dto/create-provisioning-operation.dto';
import { ListOperationsQuery } from './dto/list-operations.query';
import { GetProjectQuery } from './dto/get-project.query';
import { OperationEventResponse } from './dto/operation-event-response';
import { OperationEventsPage } from './dto/operation-events-page.dto';
import { ListOperationEventsQuery } from './dto/list-operation-events.query';

// ── Response types ────────────────────────────────────────

export interface ProvisioningOperationResponse {
  provisioningOperationId: string;
  provisioningProjectId: string;
  type: string;
  status: string;
  dryRun: boolean;
  idempotencyKey: string;
  idempotent: boolean;
  createdAt: Date;
}

function toProvisioningOperationResponse(
  op: ProvisioningOperation,
  idempotent: boolean,
): ProvisioningOperationResponse {
  return {
    provisioningOperationId: op.id,
    provisioningProjectId: op.provisioningProjectId,
    type: op.type,
    status: op.status,
    dryRun: op.dryRun,
    idempotencyKey: op.idempotencyKey,
    idempotent,
    createdAt: op.createdAt,
  };
}

// GET /v1/provisioning/resources response item
export interface GetResourceResponse {
  id: string;
  projectId: string;                        // platform project ID
  type: string;                             // mapped from Prisma `kind`
  name: string | null;
  status: string;
  externalId: string | null;
  desiredSpec: Record<string, unknown>;
  actualSpec: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

type ResourceRow = {
  id: string;
  kind: string;
  name: string;
  status: string;
  externalId: string | null;
  desiredSpec: unknown;
  actualSpec: unknown;
  destroyedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toGetResourceResponse(
  row: ResourceRow,
  projectId: string,
): GetResourceResponse {
  return {
    id: row.id,
    projectId,
    type: row.kind,
    name: row.name,
    status: row.status,
    externalId: row.externalId,
    desiredSpec: (row.desiredSpec ?? {}) as Record<string, unknown>,
    actualSpec: (row.actualSpec ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// GET /v1/provisioning/operations/:id response
export interface GetOperationResponse {
  id: string;
  projectId: string;             // platform project ID (not provisioning project)
  type: string;
  status: string;
  dryRun: boolean;
  idempotencyKey: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: { message: string } | null;
  createdAt: string;
  updatedAt: string;             // derived: completedAt ?? startedAt ?? createdAt
  startedAt: string | null;
  completedAt: string | null;
}

type OperationWithProject = ProvisioningOperation & {
  provisioningProject: {
    projectId: string;
    project: { teamId: string };
  };
};

function toGetOperationResponse(op: OperationWithProject): GetOperationResponse {
  const updatedAt = op.completedAt ?? op.startedAt ?? op.createdAt;
  return {
    id: op.id,
    projectId: op.provisioningProject.projectId,
    type: op.type,
    status: op.status,
    dryRun: op.dryRun,
    idempotencyKey: op.idempotencyKey,
    input: (op.input ?? {}) as Record<string, unknown>,
    result: (op.result ?? null) as Record<string, unknown> | null,
    error: op.errorMessage ? { message: op.errorMessage } : null,
    createdAt: op.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    startedAt: op.startedAt?.toISOString() ?? null,
    completedAt: op.completedAt?.toISOString() ?? null,
  };
}

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
  ): Promise<ProvisioningOperationResponse> {
    // 1. Resolve provisioning project from platform projectId + assert ownership
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);

    const pp = await this.prisma.provisioningProject.findUnique({
      where: { projectId: dto.projectId },
    });
    if (!pp)
      throw new NotFoundException(
        'No provisioning project found for this project. Create one via POST /v1/provisioning/projects first.',
      );

    // 2. Idempotency check
    const existing = await this.prisma.provisioningOperation.findUnique({
      where: {
        provisioningProjectId_idempotencyKey: {
          provisioningProjectId: pp.id,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });

    if (existing) {
      // Same key → verify semantic compatibility before replaying
      const incompatible =
        existing.type !== dto.type ||
        existing.dryRun !== dto.dryRun;
      if (incompatible)
        throw new ConflictException(
          'An operation with this idempotency key already exists with a different type or dryRun value.',
        );
      // Compatible payload → idempotent replay, zero writes
      return toProvisioningOperationResponse(existing, true);
    }

    // 3. Create new operation (different key → always a new op, never 409)
    const initialStatus = dto.dryRun ? 'DRY_RUN' : 'PENDING';
    const now = new Date();

    const op = await this.prisma.$transaction(async (tx) => {
      const op = await tx.provisioningOperation.create({
        data: {
          provisioningProjectId: pp.id,
          type: dto.type,
          status: initialStatus,
          dryRun: dto.dryRun,
          idempotencyKey: dto.idempotencyKey,
          requestedBy: userId,
          input: dto.desiredSpec as any,
          startedAt: dto.dryRun ? now : undefined,
          completedAt: dto.dryRun ? now : undefined,
        },
      });

      // OPERATION_CREATED on creation; OPERATION_STARTED only when execution begins
      const auditKind: EventKind = dto.dryRun ? 'DRY_RUN_COMPLETED' : 'OPERATION_STARTED';
      await this.writeAuditEvent(tx, {
        provisioningProjectId: pp.id,
        operationId: op.id,
        kind: auditKind,
        actorUserId: userId,
        fromStatus: null,
        toStatus: initialStatus,
        detail: dto.dryRun ? { dryRun: true } : undefined,
      });

      // ROLLBACK_INITIATED emitted only when execution phase begins, not here

      return op;
    });

    return toProvisioningOperationResponse(op, false);
  }

  // ── Read endpoints ────────────────────────────────────────

  async getOperation(userId: string, operationId: string): Promise<GetOperationResponse> {
    // Single query — join through to teamId for ownership check
    const op = await this.prisma.provisioningOperation.findUnique({
      where: { id: operationId },
      include: {
        provisioningProject: {
          select: {
            projectId: true,
            project: { select: { teamId: true } },
          },
        },
      },
    });

    // 404 for both not-found and wrong-team — no cross-team existence leakage
    if (!op) throw new NotFoundException('Operation not found');

    const teamId = op.provisioningProject.project.teamId;
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new NotFoundException('Operation not found');

    return toGetOperationResponse(op);
  }

  async cancelOperation(userId: string, operationId: string): Promise<GetOperationResponse> {
    // 1. Load operation with project+team for ownership check
    const op = await this.prisma.provisioningOperation.findUnique({
      where: { id: operationId },
      include: {
        provisioningProject: {
          select: {
            projectId: true,
            project: { select: { teamId: true } },
          },
        },
      },
    });

    // 404 for both not-found and wrong-team — no cross-team existence leakage
    if (!op) throw new NotFoundException('Operation not found');

    const teamId = op.provisioningProject.project.teamId;
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new NotFoundException('Operation not found');

    // 3. Only PENDING operations can be cancelled
    if (op.status !== 'PENDING') {
      throw new BadRequestException('Only PENDING operations can be cancelled');
    }

    // 4. Update to CANCELLED + completedAt=now + write STATUS_CHANGED audit event
    const now = new Date();
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.provisioningOperation.update({
        where: { id: op.id },
        data: { status: 'CANCELLED' as any, completedAt: now },
        include: {
          provisioningProject: {
            select: {
              projectId: true,
              project: { select: { teamId: true } },
            },
          },
        },
      });

      await this.writeAuditEvent(tx, {
        provisioningProjectId: op.provisioningProjectId,
        operationId: op.id,
        kind: 'STATUS_CHANGED',
        actorUserId: userId,
        fromStatus: 'PENDING',
        toStatus: 'CANCELLED',
      });

      return updated;
    });

    // 5. Return mapped response (same shape as getOperation)
    return toGetOperationResponse(cancelled as OperationWithProject);
  }

  async listResources(
    userId: string,
    projectId: string,
    includeDestroyed = false,
  ): Promise<GetResourceResponse[]> {
    // 1. Ownership — 404 if project missing or user not in team
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new NotFoundException('Project not found');

    // 2. Resolve provisioning project — empty list if not yet created
    const pp = await this.prisma.provisioningProject.findUnique({
      where: { projectId },
      select: { id: true },
    });
    if (!pp) return [];

    // 3. Fetch resources — rollbackSpec excluded (sensitive operational data)
    const rows = await this.prisma.provisioningResource.findMany({
      where: {
        provisioningProjectId: pp.id,
        ...(includeDestroyed ? {} : { destroyedAt: null }),
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        kind: true,
        name: true,
        status: true,
        externalId: true,
        desiredSpec: true,
        actualSpec: true,
        destroyedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return rows.map((r) => toGetResourceResponse(r, projectId));
  }

  // ── List + project status ─────────────────────────────────

  async listOperations(
    userId: string,
    query: ListOperationsQuery,
  ): Promise<GetOperationResponse[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: query.projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);

    const pp = await this.prisma.provisioningProject.findUnique({
      where: { projectId: query.projectId },
      select: { id: true },
    });
    if (!pp) return [];

    const ops = await this.prisma.provisioningOperation.findMany({
      where: {
        provisioningProjectId: pp.id,
        ...(query.status ? { status: query.status as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 20,
      include: {
        provisioningProject: {
          select: {
            projectId: true,
            project: { select: { teamId: true } },
          },
        },
      },
    });

    return ops.map((op) => toGetOperationResponse(op as OperationWithProject));
  }

  async getProject(userId: string, query: GetProjectQuery) {
    const project = await this.prisma.project.findUnique({
      where: { id: query.projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);

    const pp = await this.prisma.provisioningProject.findUnique({
      where: { projectId: query.projectId },
      select: { id: true, provider: true, region: true, datacenter: true, status: true, createdAt: true },
    });
    if (!pp) throw new NotFoundException('No provisioning project found for this project');

    return {
      provisioningProjectId: pp.id,
      provider: pp.provider,
      region: pp.region,
      datacenter: pp.datacenter ?? null,
      status: pp.status,
      createdAt: pp.createdAt,
    };
  }

  // ── Audit events ──────────────────────────────────────────

  async listOperationEvents(
    userId: string,
    operationId: string,
    query: ListOperationEventsQuery = {},
  ): Promise<OperationEventsPage> {
    const limit = query.limit ?? 50;

    const op = await this.prisma.provisioningOperation.findUnique({
      where: { id: operationId },
      include: {
        provisioningProject: {
          select: { project: { select: { teamId: true } } },
        },
      },
    });
    if (!op) throw new NotFoundException('Operation not found');

    const teamId = op.provisioningProject.project.teamId;
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new NotFoundException('Operation not found');

    // Decode cursor — throws 400 on malformed input
    let cursorFilter: Record<string, unknown> = {};
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      cursorFilter = {
        OR: [
          { createdAt: { gt: decoded.createdAt } },
          { createdAt: { equals: decoded.createdAt }, id: { gt: decoded.id } },
        ],
      };
    }

    // Fetch one extra row to determine whether a next page exists
    const rows = await this.prisma.provisioningAuditEvent.findMany({
      where: { operationId, ...cursorFilter },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? encodeCursor({ createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id })
      : null;

    return {
      events: page.map((e) => ({
        id: e.id,
        kind: e.kind,
        fromStatus: e.fromStatus ?? null,
        toStatus: e.toStatus ?? null,
        actorUserId: e.actorUserId ?? null,
        metadata: (e.detail ?? null) as Record<string, unknown> | null,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }
}

// ── Cursor helpers ─────────────────────────────────────────

interface EventCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed.createdAt || !parsed.id) throw new Error('missing fields');
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
