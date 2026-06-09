import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  IProvisioningProvider,
  PROVISIONING_PROVIDER,
} from './interfaces/provisioning-provider.interface';

// Executable terminal statuses that block re-execution
const NON_EXECUTABLE_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'DRY_RUN',
  'ROLLED_BACK',
] as const;

type AuditEventKind =
  | 'STATUS_CHANGED'
  | 'OPERATION_COMPLETED'
  | 'OPERATION_FAILED';

@Injectable()
export class ProvisioningExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVISIONING_PROVIDER)
    private readonly provider: IProvisioningProvider,
  ) {}

  async executeOperation(userId: string, operationId: string) {
    // Load operation with full context needed for ownership + execution
    const op = await this.prisma.provisioningOperation.findUnique({
      where: { id: operationId },
      include: {
        provisioningProject: {
          include: {
            project: { select: { teamId: true } },
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

    // State guard: only PENDING operations may be executed
    if ((NON_EXECUTABLE_STATUSES as readonly string[]).includes(op.status)) {
      throw new BadRequestException(
        `Operation is in status ${op.status} and cannot be executed. Only PENDING operations are executable.`,
      );
    }

    // ── PENDING → RUNNING ────────────────────────────────────────
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
    });

    // ── Provider call + terminal transition ──────────────────────
    try {
      const providerResult = await this.provider.execute({
        operationId: op.id,
        type: op.type,
        input: op.input,
        // Pass only the OpenBao path reference — never actual credential bytes
        credentialOpenbaoPath: op.provisioningProject.credentialRef.openbaoPath,
      });

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
      });
      return completed;
    } catch (err) {
      // RUNNING → FAILED
      const errorMessage = err instanceof Error ? err.message : String(err);
      const failed = await this.prisma.provisioningOperation.update({
        where: { id: op.id },
        data: { status: 'FAILED', errorMessage, completedAt: new Date() },
      });
      await this.writeAuditEvent({
        provisioningProjectId: op.provisioningProjectId,
        operationId: op.id,
        kind: 'OPERATION_FAILED',
        actorUserId: userId,
        fromStatus: 'RUNNING',
        toStatus: 'FAILED',
        detail: { error: errorMessage },
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
