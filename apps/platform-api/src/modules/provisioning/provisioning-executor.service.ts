import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProvisioningExecuteInput } from './interfaces/provisioning-provider.interface';
import { IProviderRegistry, PROVIDER_REGISTRY } from './interfaces/provider-registry.interface';
import { normalizeProviderError } from './interfaces/provider-error.interface';

type AuditEventKind =
  | 'STATUS_CHANGED'
  | 'OPERATION_COMPLETED'
  | 'OPERATION_FAILED';

@Injectable()
export class ProvisioningExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_REGISTRY) private readonly registry: IProviderRegistry,
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
    // Rejecting all other statuses (including future ones) by default.
    if (op.status !== 'PENDING') {
      throw new BadRequestException(
        `Operation is in status ${op.status} and cannot be executed. Only PENDING operations are executable.`,
      );
    }

    // Build the full provider input contract — openbao path only, no secret resolution here
    const input: ProvisioningExecuteInput = {
      operationId: op.id,
      projectId: op.provisioningProject.project.id,
      providerType: op.provisioningProject.provider,
      region: op.provisioningProject.region,
      datacenter: op.provisioningProject.datacenter ?? null,
      desiredSpec: op.input,
      // The executor passes the path reference only; the provider handles secret resolution
      credentialOpenbaoPath: op.provisioningProject.credentialRef.openbaoPath,
    };

    // Resolve provider before mutating state — unknown type fails here with 400, not after RUNNING
    const provider = this.registry.resolve(input.providerType);

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

    // ── Provider call + terminal transition ────────────────────
    try {
      const providerResult = await provider.execute(input);

      // RUNNING → COMPLETED
      const completed = await this.prisma.provisioningOperation.update({
        where: { id: op.id },
        data: {
          status: 'COMPLETED',
          result: (providerResult.result as any) ?? undefined,
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
    } catch (err) {
      // RUNNING → FAILED; failure is normalized and stored — never re-thrown
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
    }
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
