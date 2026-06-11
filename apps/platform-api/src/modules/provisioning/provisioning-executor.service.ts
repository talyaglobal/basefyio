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
  ProviderCurrentResource,
  ProvisioningExecuteInput,
} from './interfaces/provisioning-provider.interface';
import { IProviderRegistry, PROVIDER_REGISTRY } from './interfaces/provider-registry.interface';
import { normalizeProviderError } from './interfaces/provider-error.interface';
import { PartialApplyError } from './interfaces/partial-apply.error';
import { ProvisioningResourceProjectionService } from './provisioning-resource-projection.service';

type AuditEventKind =
  | 'STATUS_CHANGED'
  | 'OPERATION_COMPLETED'
  | 'OPERATION_FAILED'
  | 'DRY_RUN_COMPLETED'
  | 'ROLLBACK_INITIATED'
  | 'ROLLBACK_COMPLETED'
  | 'RETRY_STARTED'
  | 'RETRY_COMPLETED'
  | 'RETRY_FAILED';

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

    const isRetry = op.retryOfOperationId != null;

    // Resolve provider before mutating state — unknown type fails here with 400, not after RUNNING
    const provider = this.registry.resolve(op.provisioningProject.provider);

    // ROLLBACK operations use a separate execution path that derives desired state from rollbackSpec
    if (op.type === 'ROLLBACK') {
      return this.executeRollback(op, provider, userId);
    }

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
    const isDryRun = op.dryRun ?? false;
    const input: ProvisioningExecuteInput = {
      operationId: op.id,
      projectId: op.provisioningProject.project.id,
      providerType: op.provisioningProject.provider,
      region: op.provisioningProject.region,
      datacenter: op.provisioningProject.datacenter ?? null,
      desiredSpec: op.input,
      credentialOpenbaoPath: op.provisioningProject.credentialRef.openbaoPath,
      currentResources,
      dryRun: isDryRun,
    };

    // ── PENDING → RUNNING ──────────────────────────────────────
    await this.prisma.provisioningOperation.update({
      where: { id: op.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await this.writeAuditEvent({
      provisioningProjectId: op.provisioningProjectId,
      operationId: op.id,
      kind: isRetry ? 'RETRY_STARTED' : 'STATUS_CHANGED',
      actorUserId: userId,
      fromStatus: 'PENDING',
      toStatus: 'RUNNING',
      detail: isRetry
        ? { retryOfOperationId: op.retryOfOperationId, providerType: input.providerType, region: input.region }
        : { providerType: input.providerType, region: input.region },
    });

    // ── Provider call (separate catch — failure → FAILED, not propagated) ────
    let providerResult;
    try {
      providerResult = await provider.apply(input);
    } catch (err) {
      // PartialApplyError: some actions succeeded, some failed.
      // Run projection for successfully applied resources, then set PARTIAL_FAILED.
      if (err instanceof PartialApplyError && err.appliedResources.length > 0) {
        if (err.appliedResources.length || err.deletedExternalIds.length) {
          await this.projection.project({
            operationId: op.id,
            provisioningProjectId: op.provisioningProjectId,
            region: op.provisioningProject.region,
            datacenter: op.provisioningProject.datacenter ?? null,
            resources: err.appliedResources,
            deletedExternalIds: err.deletedExternalIds,
            actorUserId: userId,
          });
        }
        const failSummary = err.failures.map((f) => `${f.action} ${f.resourceType}:${f.resourceName}`).join('; ');
        const partial = await this.prisma.provisioningOperation.update({
          where: { id: op.id },
          data: { status: 'PARTIAL_FAILED' as any, errorMessage: err.message, completedAt: new Date() },
        });
        await this.writeAuditEvent({
          provisioningProjectId: op.provisioningProjectId,
          operationId: op.id,
          kind: isRetry ? 'RETRY_FAILED' : 'OPERATION_FAILED',
          actorUserId: userId,
          fromStatus: 'RUNNING',
          toStatus: 'PARTIAL_FAILED',
          detail: {
            providerType: input.providerType,
            region: input.region,
            error: 'PARTIAL_APPLY',
            message: err.message,
            failedActions: failSummary,
            retryable: false,
          },
        });
        return partial;
      }

      // Total failure: no successful actions (PartialApplyError with 0 applied, or regular error).
      const normalized = normalizeProviderError(err);
      const failed = await this.prisma.provisioningOperation.update({
        where: { id: op.id },
        data: { status: 'FAILED', errorMessage: normalized.message, completedAt: new Date() },
      });
      await this.writeAuditEvent({
        provisioningProjectId: op.provisioningProjectId,
        operationId: op.id,
        kind: isRetry ? 'RETRY_FAILED' : 'OPERATION_FAILED',
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
      // projection is NOT called for total failure — no resource mutations occurred
    }

    // ── Resource projection (before COMPLETED update) ───────────────────────
    // Dry-run operations produce no resource mutations — projection is skipped.
    // If projection fails, the operation stays RUNNING and can be recovered.
    // A COMPLETED operation with missing resource rows is a harder inconsistency to fix.
    if (!isDryRun && (providerResult.resources?.length || providerResult.deletedExternalIds?.length)) {
      await this.projection.project({
        operationId: op.id,
        provisioningProjectId: op.provisioningProjectId,
        region: op.provisioningProject.region,
        datacenter: op.provisioningProject.datacenter ?? null,
        resources: providerResult.resources,
        deletedExternalIds: providerResult.deletedExternalIds,
        actorUserId: userId,
      });
    }

    // ── RUNNING → COMPLETED / DRY_RUN (only after projection succeeds) ──────
    const finalStatus = isDryRun ? 'DRY_RUN' : 'COMPLETED';
    const finalAuditKind: AuditEventKind = isDryRun ? 'DRY_RUN_COMPLETED' : (isRetry ? 'RETRY_COMPLETED' : 'OPERATION_COMPLETED');
    const completed = await this.prisma.provisioningOperation.update({
      where: { id: op.id },
      data: {
        status: finalStatus,
        result: {
          metadata: providerResult.metadata ?? {},
          resourceCount: providerResult.resources?.length ?? 0,
          deletedCount: providerResult.deletedExternalIds?.length ?? 0,
        } as any,
        completedAt: new Date(),
      },
    });
    await this.writeAuditEvent({
      provisioningProjectId: op.provisioningProjectId,
      operationId: op.id,
      kind: finalAuditKind,
      actorUserId: userId,
      fromStatus: 'RUNNING',
      toStatus: finalStatus,
      detail: { providerType: input.providerType, region: input.region },
    });
    return completed;
  }

  // ── ROLLBACK execution ────────────────────────────────────────────────────

  private async executeRollback(
    op: {
      id: string;
      provisioningProjectId: string;
      provisioningProject: {
        provider: string;
        region: string;
        datacenter: string | null;
        project: { id: string };
        credentialRef: { openbaoPath: string };
      };
    },
    provider: IProvisioningProvider,
    userId: string,
  ) {
    // Load ALL project resources — active and destroyed — to build the rollback plan.
    // Active resources without rollbackSpec were created by the forward op → DELETE them.
    // Resources with rollbackSpec (active or destroyed) → restore to that spec.
    const allRows = await this.prisma.provisioningResource.findMany({
      where: { provisioningProjectId: op.provisioningProjectId },
      select: {
        id: true,
        kind: true,
        name: true,
        status: true,
        desiredSpec: true,
        actualSpec: true,
        externalId: true,
        rollbackSpec: true,
        destroyedAt: true,
      },
    });

    // currentResources: only active (non-destroyed) rows — what the provider diffs against
    const currentResources: ProviderCurrentResource[] = allRows
      .filter((r) => r.destroyedAt === null)
      .map((r) => ({
        id: r.id,
        type: r.kind,
        name: r.name,
        status: r.status,
        desiredSpec: (r.desiredSpec ?? {}) as Record<string, unknown>,
        actualSpec: (r.actualSpec ?? null) as Record<string, unknown> | null,
        externalId: r.externalId,
      }));

    // Rollback desired state: resources with rollbackSpec → restore; active without → omit (→ DELETE)
    const rollbackResources = allRows
      .filter((r) => r.rollbackSpec !== null)
      .map((r) => ({
        type: (r.kind as string).toLowerCase(),
        name: r.name,
        spec: r.rollbackSpec,
      }));
    const desiredSpec = { resources: rollbackResources };

    const input: ProvisioningExecuteInput = {
      operationId: op.id,
      projectId: op.provisioningProject.project.id,
      providerType: op.provisioningProject.provider,
      region: op.provisioningProject.region,
      datacenter: op.provisioningProject.datacenter ?? null,
      desiredSpec,
      credentialOpenbaoPath: op.provisioningProject.credentialRef.openbaoPath,
      currentResources,
      dryRun: false,
    };

    // ── PENDING → RUNNING ──────────────────────────────────────
    await this.prisma.provisioningOperation.update({
      where: { id: op.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await this.writeAuditEvent({
      provisioningProjectId: op.provisioningProjectId,
      operationId: op.id,
      kind: 'ROLLBACK_INITIATED',
      actorUserId: userId,
      fromStatus: 'PENDING',
      toStatus: 'RUNNING',
      detail: { providerType: input.providerType, region: input.region },
    });

    // ── Provider call ──────────────────────────────────────────
    let providerResult;
    try {
      providerResult = await provider.apply(input);
    } catch (err) {
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

    // ── Projection ─────────────────────────────────────────────
    if (providerResult.resources?.length || providerResult.deletedExternalIds?.length) {
      await this.projection.project({
        operationId: op.id,
        provisioningProjectId: op.provisioningProjectId,
        region: op.provisioningProject.region,
        datacenter: op.provisioningProject.datacenter ?? null,
        resources: providerResult.resources,
        deletedExternalIds: providerResult.deletedExternalIds,
        actorUserId: userId,
      });
    }

    // ── Mark restored resources ROLLED_BACK (projection set them ACTIVE) ────
    if (providerResult.resources?.length) {
      await this.prisma.provisioningResource.updateMany({
        where: {
          provisioningProjectId: op.provisioningProjectId,
          externalId: { in: providerResult.resources.map((r) => r.externalId) },
        },
        data: { status: 'ROLLED_BACK' as any },
      });
    }

    // ── Project → ROLLED_BACK ──────────────────────────────────
    await this.prisma.provisioningProject.update({
      where: { id: op.provisioningProjectId },
      data: { status: 'ROLLED_BACK' as any },
    });

    // ── RUNNING → ROLLED_BACK ──────────────────────────────────
    const completed = await this.prisma.provisioningOperation.update({
      where: { id: op.id },
      data: {
        status: 'ROLLED_BACK',
        result: {
          metadata: providerResult.metadata ?? {},
          resourceCount: providerResult.resources?.length ?? 0,
          deletedCount: providerResult.deletedExternalIds?.length ?? 0,
        } as any,
        completedAt: new Date(),
      },
    });
    await this.writeAuditEvent({
      provisioningProjectId: op.provisioningProjectId,
      operationId: op.id,
      kind: 'ROLLBACK_COMPLETED',
      actorUserId: userId,
      fromStatus: 'RUNNING',
      toStatus: 'ROLLED_BACK',
      detail: { providerType: input.providerType, region: input.region },
    });

    return completed;
  }

  // ── Shared audit helper ───────────────────────────────────────

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
