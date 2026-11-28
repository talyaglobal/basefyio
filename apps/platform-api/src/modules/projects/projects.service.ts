import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  BadRequestException,
  BadGatewayException,
  ConflictException,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { PgBouncerService } from '../pgbouncer/pgbouncer.service';
import { QuotaService, QuotaExceededException } from '../billing/quota.service';
import { UsageService } from '../billing/usage.service';
import { buildProjectResources, type ProjectResources } from './project-resources';
import { InfrastructureService } from '../infrastructure/infrastructure.service';
import { DataEngineService } from '../data-engine/data-engine.service';
import { CreateProjectDto, UpdateDataAccessDto } from './dto/create-project.dto';
import {
  computeOptionsFor,
  computeTierRefusal,
  dedicatedSizeFor,
  DEFAULT_REGION,
  type ComputeOptions,
  type ComputeTierId,
} from './project-compute';
import { ExposedSchemasError, restSchemasView, validateExposedSchemas } from './postgrest/exposed-schemas';
import {
  dataAccessOf,
  renderDataAccessSql,
  renderRlsBootstrap,
  withDataAccessDefaults,
  type DataAccessFlags,
} from './project-data-access';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { AdminTarget, ProjectProvisioningService } from './project-provisioning.service';
import { ProjectReadonlyRoleService, readonlyRoleNameFor } from './project-readonly-role.service';
import {
  ProjectExtraRoleService,
  isBuiltInMember,
  memberOfColumn,
  memberOfFromColumn,
  parseMemberOf,
  parseRoleSettings,
  type ExtraRoleSettings,
} from './project-extra-role.service';
import { assertRolePrefix, foreignPrefixRoles, prefixedRoleName, usesPrefix } from './project-role-prefix';
import { previewBranchOf } from './branches/preview-branch';
import { stripProjectSecrets } from './project-secrets';
import { prefixIsAmbiguous } from '../storage/bucket-names';
import { BootTaskService } from '../cluster/boot-task.service';
import {
  grantedByRole,
  requireRolePermission,
  roleAllows,
  type PermissionKey,
} from '../teams/role-permissions';
import { TRASH_RETENTION_MS } from './project-trash-notice.service';
import {
  NO_REASON_LABEL,
  lastTrashReason,
  listDeletionEntries,
  normalizeDeletionReason,
  recordProjectDeletion,
} from './project-deletion-records';
import { isStarterKey, starterSql, starterTables, type StarterKey } from './sql/starter-templates';


export interface RlsBootstrapResult {
  bootstrappedAt: Date;
  sentinelPassed: boolean;
  rolesPresent: string[];
  failedRoles: string[];
  currentUser: string | null;
}

export interface RlsDiagnostic {
  projectId: string;
  onSharedHost: boolean;
  currentUser: string | null;
  connectingUser: string;
  rolesPresent: string[];
  /** member rolname → array of granted role rolnames. */
  memberships: Record<string, string[]>;
  /** target role → SET ROLE attempt result. */
  setRoleResults: Record<string, { ok: boolean; error?: string }>;
  failedRoles: string[];
  sentinelPassed: boolean;
}

const AUTH_RECREATED_MESSAGE =
  'Project reactivated. Authentication was recreated; previous users and settings could not be restored.';

/** Never the password: it leaves the API only in the create / rotate answer and the credentials reveal. */
const SELECT_XR = { id: true, label: true, roleName: true, memberOf: true, settings: true, kind: true, createdAt: true } as const;
/** Login roles per project, and group roles per project. */
export const MAX_EXTRA_ROLES_PER_KIND = 10;
type ExtraRoleAuditAction = 'created' | 'updated' | 'password_rotated' | 'dropped';

@Injectable()
export class ProjectsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
    private readonly config: ConfigService,
    private readonly pgbouncer: PgBouncerService,
    private readonly activity: ProjectActivityService,
    private readonly quota: QuotaService,
    private readonly usageService: UsageService,
    private readonly infra: InfrastructureService,
    private readonly realtime: RealtimeEventsService,
    private readonly dataEngine: DataEngineService,
    private readonly provisioning: ProjectProvisioningService,
    private readonly readonlyRole: ProjectReadonlyRoleService,
    private readonly extraRole: ProjectExtraRoleService,
    @Optional() private readonly bootTasks?: BootTaskService,
  ) {}

  /** One replica, once per boot: give the projects that lost their read-only role one. */
  onApplicationBootstrap(): void {
    void this.repairMissingReadonlyRoles();
  }

  /**
   * Between 2026-10-20 and 2026-10-26 every new project was created without its
   * read-only companion role: the provisioning call spread the admin target and
   * then set `password` for the role, so the admin connection used the role's
   * secret and failed. The fix is in the service; this adds the role to the
   * projects created while it was broken. Idempotent, a few at a time, logged.
   */
  async repairMissingReadonlyRoles(): Promise<number> {
    if (this.config.get<boolean>('provisioning.readonlyRole') === false) return 0;
    try {
      if (!((await this.bootTasks?.claim('readonly-role-repair', 6 * 60 * 60_000)) ?? true)) return 0;
      const projects = await this.prisma.project.findMany({
        where: { status: 'ACTIVE', databaseType: 'RELATIONAL', dbReadonlyUser: null, createdAt: { gte: new Date('2026-10-19T00:00:00Z') } },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      let repaired = 0;
      for (const project of projects) {
        try {
          const target = this.provisioning.resolveAdminTarget(project);
          const readonlyRole = readonlyRoleNameFor(project.dbUser);
          const rolePassword = randomBytes(24).toString('base64url');
          await this.readonlyRole.provision({ ...target, dbName: project.dbName, ownerUser: project.dbUser, readonlyRole, rolePassword });
          await this.prisma.project.update({ where: { id: project.id }, data: { dbReadonlyUser: readonlyRole, dbReadonlyPassword: rolePassword } });
          repaired++;
        } catch (err: any) {
          this.logger.warn(`Read-only role repair skipped for ${project.slug}: ${err?.message ?? err}`);
        }
      }
      if (repaired > 0) {
        this.logger.log(`Read-only roles repaired for ${repaired} project(s)`);
        this.pgbouncer.regenerateConfig().catch((err) => this.logger.warn(`PgBouncer config update failed: ${err}`));
      }
      return repaired;
    } catch (err: any) {
      this.logger.warn(`Read-only role repair failed: ${err?.message ?? err}`);
      return 0;
    }
  }

  /**
   * Returns the ids of every TeamMember in a given team — used as the
   * Realtime `userIds` recipient list for project-scoped events. Everyone
   * in the team sees "X created project Y", "X deleted project Z", etc.
   * The actor is filtered out at the subscriber (own-action skip).
   */
  private async teamMemberUserIds(teamId: string): Promise<string[]> {
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /**
   * Resolve "First Last" (or email) for the Realtime payload so the toast
   * can say "Alice created project X" without a follow-up HTTP call.
   */
  private async resolveActorName(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });
    if (!u) return null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return name || u.email || null;
  }

  async create(
    dto: CreateProjectDto & { teamId: string },
    userId: string,
    importSource: 'MANUAL' | 'SUPABASE' | 'ZIP' | 'BRANCH' = 'MANUAL',
    opts?: {
      /**
       * Set when the new project is a preview branch of another. Branches are
       * free (capped per parent instead of counted against the plan) and always
       * live on the shared cluster next to their parent.
       */
      branch?: { parentProjectId: string; branchName: string; dataMode: 'schema' | 'full' };
    },
  ) {
    const branch = opts?.branch;
    const normalizedName = dto.name.trim();
    if (!normalizedName) {
      throw new BadRequestException('Project name is required');
    }
    const existingByName = await this.prisma.project.findFirst({
      where: {
        name: {
          equals: normalizedName,
          mode: 'insensitive',
        },
        teamId: dto.teamId,
        status: { not: 'DELETED' },
      },
      select: { id: true, name: true },
    });
    if (existingByName) {
      throw new BadRequestException('A project with this name already exists in this team');
    }

    const creatorRole = await this.assertTeamMember(dto.teamId, userId);
    // canCreateProjects was stored and shown but never read; it is applied as
    // far as ORG_PERMISSIONS_ENFORCED allows (logged first, denied later).
    await requireRolePermission(this.prisma, this.logger, {
      teamId: dto.teamId,
      userId,
      role: creatorRole,
      key: 'canCreateProjects',
    });
    if (!branch) await this.quota.assertCanCreateProject(dto.teamId);

    const databaseType: 'RELATIONAL' | 'NOSQL' = dto.databaseType ?? 'RELATIONAL';
    const region = dto.region ?? DEFAULT_REGION;
    const dataAccess = withDataAccessDefaults(dto.dataAccess);

    // A password the customer chose meets the same rules as a rotated one;
    // none chosen means one is generated, as before.
    const chosenPassword = dto.dbPassword?.trim();
    if (chosenPassword) this.assertStrongDbPassword(chosenPassword);

    // The compute size is the server's decision, whatever the dialog showed: a
    // dedicated size needs a plan that includes one and a region with room.
    const computeTier: ComputeTierId = branch ? 'shared' : (dto.computeTier ?? 'shared');
    let dedicatedPlan: Awaited<ReturnType<QuotaService['getTeamPlan']>> = null;
    if (computeTier !== 'shared') {
      dedicatedPlan = await this.quota.getTeamPlan(dto.teamId);
      const refusal = computeTierRefusal(computeTier, {
        planDedicated: dedicatedPlan?.dedicatedDb === true,
        planDisplayName: dedicatedPlan?.displayName ?? 'Free',
        regionHasCapacity: this.infra.isDedicatedDbEnabled(),
      });
      if (refusal) throw new BadRequestException(refusal);
    }

    // Dedicated placement is a deliberate, capacity-bound decision, so it takes
    // two things: a host declared to have room (DEDICATED_DB_ENABLED) and a plan
    // that includes it. Docker being reachable is not on its own a reason to
    // hand a project its own database — that would put every new project,
    // free ones included, on a container of its own.
    //
    // Projects keep whatever placement they were created with; a plan change
    // does not move data between the shared cluster and a dedicated container.
    //
    // A dedicated size chosen in the dialog was checked above; without one, a
    // plan with a dedicated database keeps getting one, sized by the plan.
    const needsDedicatedDb =
      !branch &&
      (computeTier !== 'shared' ||
        (this.infra.isDedicatedDbEnabled() && (await this.quota.shouldUseDedicatedDb(dto.teamId))));

    const projectId = randomUUID();
    const slug = await this.uniqueSlug(this.toSlug(normalizedName));
    const storagePrefix = await this.newProjectStoragePrefix(slug);
    const { dbName, dbUser } = await this.uniqueDatabaseNameAndUser();
    const dbPassword = chosenPassword || randomBytes(24).toString('base64url');
    const realmName = `bf-${slug}`;
    const dbHost = this.config.get<string>('database.host')!;
    const dbPort = this.config.get<number>('database.port')!;

    // Fail fast if Keycloak is down — avoids creating orphaned DB resources
    await this.keycloak.assertHealthy();

    let actualDbHost = dbHost;
    let actualDbPort = dbPort;
    let actualAdminUser: string | undefined;
    let actualAdminPassword: string | undefined;
    // Held until the project row exists: the infrastructure record cannot be
    // written before then, and a rollback has no other way to find the container.
    let dedicatedPg:
      | {
          containerName: string;
          volumeName: string;
          adminUser: string;
          adminPassword: string;
          memoryMb: number;
          cpuMillis: number;
        }
      | undefined;

    if (needsDedicatedDb) {
      try {
        const size = dedicatedSizeFor(computeTier);
        const plan = size ? null : await this.quota.getTeamPlan(dto.teamId);
        const memoryMb = size?.memoryMb ?? (plan?.dbMemoryMb || 1024);
        const cpuMillis = size?.cpuMillis ?? (plan?.dbCpuMillis || 1000);
        const pgResult = await this.infra.provisionPostgres({
          projectId,
          projectSlug: slug,
          memoryMb,
          cpuMillis,
        });
        actualDbHost = pgResult.host;
        actualDbPort = pgResult.port;
        actualAdminUser = pgResult.adminUser;
        actualAdminPassword = pgResult.adminPassword;
        dedicatedPg = {
          containerName: pgResult.containerName,
          volumeName: pgResult.volumeName,
          adminUser: pgResult.adminUser,
          adminPassword: pgResult.adminPassword,
          memoryMb,
          cpuMillis,
        };
      } catch (err: any) {
        // Loud on purpose: the project stays usable on the shared cluster, but
        // it is not getting the isolation its plan was sold on. This downgrade
        // went unnoticed for months at warn level.
        this.logger.error(
          `Failed to provision dedicated Postgres for "${normalizedName}", falling back to the shared cluster: ${err.message}`,
          err?.stack,
        );
      }
    }

    if (actualAdminUser && actualAdminPassword) {
      await this.createDatabaseOnHost(dbName, actualDbHost, actualDbPort, actualAdminUser, actualAdminPassword);
      await this.createDatabaseUserOnHost(dbUser, dbPassword, dbName, actualDbHost, actualDbPort, actualAdminUser, actualAdminPassword);
      await this.applyRlsBootstrapOnHost(dbName, dbUser, actualDbHost, actualDbPort, actualAdminUser, actualAdminPassword, dataAccess);
    } else {
      await this.createDatabase(dbName);
      await this.createDatabaseUser(dbUser, dbPassword, dbName);
      await this.applyRlsBootstrap(dbName, dbUser, dataAccess);
    }

    const adminTarget: AdminTarget =
      actualAdminUser && actualAdminPassword
        ? { host: actualDbHost, port: actualDbPort, user: actualAdminUser, password: actualAdminPassword }
        : this.sharedAdminTarget();
    if (importSource === 'MANUAL') {
      // Imports bring their own extension layout (the importer installs into an
      // `extensions` schema); pre-installing here would turn its CREATE EXTENSION
      // statements into no-ops and leave the copied schema pointing at nothing.
      // Never throws: a missing extension is reported, not fatal.
      await this.provisioning.installDefaultExtensions({ ...adminTarget, dbName });
    }
    const companion = await this.provisionReadonlyRole(adminTarget, dbName, dbUser);

    let anonKey: string;
    let serviceKey: string;

    try {
      await this.keycloak.createRealm(realmName);
      const clients = await this.keycloak.createClients(realmName);
      anonKey = clients.anonKey;
      serviceKey = clients.serviceKey;
    } catch (err: any) {
      // Clean up the potentially orphaned Keycloak realm before rolling back DB
      try {
        await this.keycloak.deleteRealm(realmName);
      } catch {
        this.logger.warn(`Rollback: could not delete orphaned realm "${realmName}"`);
      }
      if (dedicatedPg) {
        // The database lives inside the container, so removing the container
        // rolls the database back with it — nothing reached the shared host.
        await this.infra.discardPostgresContainer(
          dedicatedPg.containerName,
          dedicatedPg.volumeName,
        );
      } else {
        await this.dropDatabaseUser(dbUser);
        await this.dropDatabase(dbName);
        if (companion) {
          await this.readonlyRole
            .drop({ ...adminTarget, readonlyRole: companion.user })
            .catch(() => undefined);
        }
      }
      const reason = err?.message || 'unknown error';
      this.logger.error(`Keycloak realm creation failed (${reason}), rolling back`, err);
      throw new InternalServerErrorException(
        `Failed to provision authentication realm: ${reason}`,
      );
    }

    const project = await this.prisma.project.create({
      data: {
        id: projectId,
        name: normalizedName,
        slug,
        ...(storagePrefix ? { storagePrefix } : {}),
        description: dto.description,
        dbName,
        dbHost: actualDbHost,
        dbPort: actualDbPort,
        dbUser,
        dbPassword,
        dbReadonlyUser: companion?.user ?? null,
        dbReadonlyPassword: companion?.password ?? null,
        keycloakRealm: realmName,
        anonKey,
        serviceKey,
        teamId: dto.teamId,
        createdBy: userId,
        importSource,
        databaseType,
        region,
        // What the project actually runs on: a dedicated size that fell back to
        // the shared cluster is recorded as shared.
        computeTier: dedicatedPg ? computeTier : 'shared',
        dataApiEnabled: dataAccess.dataApi,
        autoGrantNewTables: dataAccess.autoGrantNewTables,
        rlsOnNewTables: dataAccess.rlsOnNewTables,
        // Requires `prisma generate` after pulling this change.
        ...({ rlsBootstrappedAt: new Date() } as any),
        ...(branch
          ? {
              parentProjectId: branch.parentProjectId,
              branchName: branch.branchName,
              branchDataMode: branch.dataMode,
              branchSyncStatus: 'pending',
            }
          : {}),
      },
    });

    if (dedicatedPg) {
      // Now that the project row exists the foreign key resolves. If this is
      // skipped the container runs unreferenced: reconciliation ignores it and
      // deleting the project leaves it behind.
      try {
        await this.infra.recordPostgresInfrastructure({
          projectId: project.id,
          ...dedicatedPg,
        });
      } catch (err: any) {
        this.logger.error(
          `Project ${project.id} runs on dedicated container ${dedicatedPg.containerName} but its infrastructure record could not be written: ${err.message}`,
        );
      }
    }

    this.logger.log(`Project "${project.name}" created (${project.id}, ${databaseType})`);

    if (databaseType === 'NOSQL') {
      // Best-effort: a slow or unreachable document store must not fail
      // project creation. Status is tracked in DataPlaneProvisioning.
      this.provisionNosqlDataPlane(project.id).catch(() => {});
    }

    if (databaseType === 'RELATIONAL' && importSource === 'MANUAL' && isStarterKey(dto.starter)) {
      await this.createStarterTables(project.id, userId, adminTarget, dbName, dbUser, dto.starter);
    }

    await this.activity.append(project.id, {
      userId,
      kind: ProjectActivityKind.PROJECT_CREATED,
      title: `Project created: ${project.name} (${databaseType === 'NOSQL' ? 'NoSQL' : 'Relational'})`,
    });

    // Realtime: notify every team member. Normal users get the toast too —
    // not only ROOT admins — because a new project in their team is
    // relevant to them (they probably want to know which projects exist).
    const memberIds = await this.teamMemberUserIds(dto.teamId);
    const actorName = await this.resolveActorName(userId);
    await this.realtime.publish({
      entityType: 'project',
      action: 'created',
      entityId: project.id,
      actorUserId: userId,
      teamId: project.teamId,
      userIds: memberIds,
      payload: {
        name: project.name,
        slug: project.slug,
        teamId: project.teamId,
        actorName,
      },
    });

    if (!branch) this.usageService.incrementProjectCount(dto.teamId).catch(() => {});

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    return project;
  }

  /**
   * Provision the Data Engine tenant for a NOSQL project. Best-effort:
   * if the engine is disabled or unreachable, record a PENDING row in
   * DataPlaneProvisioning so the tenant can be provisioned later (the
   * engine also auto-provisions lazily on first data access).
   */
  private async provisionNosqlDataPlane(projectId: string): Promise<void> {
    if (this.dataEngine.isAvailable()) {
      try {
        await this.dataEngine.provisionTenant(projectId);
        return;
      } catch (err: any) {
        // provisionTenant already recorded FAILED with the error message.
        this.logger.warn(
          `NoSQL data plane provisioning failed for ${projectId}: ${err.message}`,
        );
        return;
      }
    }

    try {
      await this.prisma.dataPlaneProvisioning.upsert({
        where: { projectId },
        create: {
          projectId,
          status: 'PENDING',
          provider: this.config.get<string>('dataEngine.provider') || 'postgres',
        },
        update: {},
      });
      this.logger.warn(
        `Data Engine unavailable — NoSQL data plane for ${projectId} marked PENDING`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Could not record pending data plane for ${projectId}: ${err.message}`,
      );
    }
  }

  async findAll(teamId: string, userId: string) {
    await this.assertTeamMember(teamId, userId);

    const projects = await this.prisma.project.findMany({
      // Deactivated projects are hidden from the main list; they live in their
      // own "Deactivated" view (like trash) until reactivated or auto-purged.
      where: { teamId, status: { notIn: ['DELETED', 'DEACTIVATED'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        databaseType: true,
        folderId: true,
        folder: { select: { id: true, name: true, color: true } },
        tags: {
          select: {
            tag: { select: { id: true, name: true, color: true } },
          },
        },
        createdBy: true,
        dbName: true,
        createdAt: true,
        updatedAt: true,
        parentProjectId: true,
        branchName: true,
        branchSyncStatus: true,
      },
    });

    const creatorIds = Array.from(
      new Set(
        projects
          .map((project) => project.createdBy)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const creators =
      creatorIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: creatorIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          })
        : [];
    const creatorById = new Map(
      creators.map((creator) => {
        const fullName = [creator.firstName, creator.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        const displayName = fullName || creator.email;
        return [creator.id, displayName] as const;
      }),
    );

    const dbSizeByName = new Map<string, number>();
    const dbNames = Array.from(new Set(projects.map((project) => project.dbName)));
    if (dbNames.length > 0) {
      try {
        const pool = this.getAdminPool();
        const client = await pool.connect();
        try {
          const result = await client.query<{
            datname: string;
            size_bytes: string;
          }>(
            `
              SELECT datname, pg_database_size(datname)::bigint AS size_bytes
              FROM pg_database
              WHERE datname = ANY($1::text[])
            `,
            [dbNames],
          );
          for (const row of result.rows) {
            dbSizeByName.set(row.datname, Number(row.size_bytes));
          }
        } finally {
          client.release();
          await pool.end();
        }
      } catch (err: any) {
        this.logger.warn(`Failed to resolve project DB sizes: ${err.message}`);
      }
    }

    return projects.map(({ createdBy, dbName, ...project }) => ({
      ...project,
      createdBy,
      createdByName: createdBy ? creatorById.get(createdBy) ?? null : null,
      projectSizeBytes: dbSizeByName.get(dbName) ?? null,
    }));
  }

  async update(
    id: string,
    userId: string,
    data: { folderId?: string | null; tags?: string[]; name?: string; description?: string },
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);

    const updateData: any = {};
    if (data.folderId !== undefined) updateData.folderId = data.folderId;
    if (data.name !== undefined && data.name.trim()) {
      updateData.name = data.name.trim();
      // Slug follows the name so the UI never shows a stale identifier.
      // Storage buckets stay reachable: the MinIO prefix freezes to the
      // pre-rename slug (one-time) and never moves again. The Keycloak
      // realm is a stored auth identifier and intentionally keeps its
      // original value — renaming realms would invalidate end-user logins.
      if (updateData.name !== project.name) {
        const dupe = await this.prisma.project.findFirst({
          where: {
            name: { equals: updateData.name, mode: 'insensitive' },
            teamId: project.teamId,
            id: { not: project.id },
            status: { not: 'DELETED' },
          },
          select: { id: true },
        });
        if (dupe) {
          throw new BadRequestException(
            'A project with this name already exists in this team',
          );
        }
        const nextSlug = await this.uniqueSlug(this.toSlug(updateData.name));
        if (nextSlug !== project.slug) {
          updateData.slug = nextSlug;
          if (!project.storagePrefix) {
            // Keep existing buckets reachable under the old slug, but guarantee
            // the prefix is unique so it can't collide with another project.
            updateData.storagePrefix = await this.uniqueStoragePrefix(project.slug, project.id);
          }
        }
      }
    }
    if (data.description !== undefined) updateData.description = data.description || null;

    // What was there before, so the log names only the fields that really changed (#27).
    const previousTagIds =
      data.tags !== undefined
        ? (await this.prisma.projectTagAssignment.findMany({ where: { projectId: id }, select: { tagId: true } }))
            .map((t) => t.tagId)
            .sort()
        : [];

    const [updatedProject] = await this.prisma.$transaction(async (tx) => {
      const p = await tx.project.update({ where: { id }, data: updateData });

      if (data.tags !== undefined) {
        await tx.projectTagAssignment.deleteMany({ where: { projectId: id } });
        if (data.tags.length > 0) {
          await tx.projectTagAssignment.createMany({
            data: data.tags.map((tagId) => ({ projectId: id, tagId })),
          });
        }
      }

      return [p];
    });

    const changes: string[] = [];
    if (updateData.name !== undefined && updateData.name !== project.name) changes.push('name');
    if (updateData.description !== undefined && (updateData.description ?? null) !== ((project as any).description ?? null)) {
      changes.push('description');
    }
    if (updateData.folderId !== undefined && (updateData.folderId ?? null) !== ((project as any).folderId ?? null)) {
      changes.push('folder');
    }
    if (data.tags !== undefined && [...data.tags].sort().join(',') !== previousTagIds.join(',')) changes.push('tags');
    if (changes.length > 0) {
      await this.activity.append(id, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Project updated',
        detail: `Changed: ${changes.join(', ')}`,
        metadata: { fields: changes },
      });

      // Realtime: tell the whole team about renames / folder moves / tag
      // changes. Internal-edit-only fields can be filtered on the subscriber
      // side if we ever want to throttle.
      const memberIds = await this.teamMemberUserIds(project.teamId);
      const actorName = await this.resolveActorName(userId);
      await this.realtime.publish({
        entityType: 'project',
        action: 'updated',
        entityId: id,
        actorUserId: userId,
        teamId: project.teamId,
        userIds: memberIds,
        payload: {
          name: updatedProject.name,
          changes,
          actorName,
        },
      });
    }

    return this.prisma.project.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        folderId: true,
        folder: { select: { id: true, name: true, color: true } },
        tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async rotateDatabasePassword(
    projectId: string,
    userId: string,
    nextPassword?: string,
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamPermission(project.teamId, userId, 'canResetDbPassword');

    // The rule is for a password someone chose; a generated one (32 random base64url characters)
    // often has no special character, and refusing it made rotation fail at random.
    const chosen = nextPassword?.trim();
    if (chosen) this.assertStrongDbPassword(chosen);
    const password = chosen || randomBytes(24).toString('base64url');

    const pool = this.getAdminPool();
    const client = await pool.connect();
    const sanitizedUser = project.dbUser.replace(/[^a-z0-9_]/g, '');

    try {
      await client.query(
        `ALTER USER "${sanitizedUser}" WITH PASSWORD '${password.replace(/'/g, "''")}'`,
      );

      await this.prisma.project.update({
        where: { id: project.id },
        data: { dbPassword: password },
      });

      await this.activity.append(project.id, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Database password rotated',
      });
    } catch (err: any) {
      throw new InternalServerErrorException(
        `Failed to rotate database password: ${err.message}`,
      );
    } finally {
      client.release();
      await pool.end();
    }

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    return { password };
  }

  /* ───────────── Read-only companion role & pooler limit ───────────── */

  /**
   * Load a project for a database-credential operation: it must exist and the
   * caller needs the team's "reset database password" permission (owners always
   * have it) — the same gate as rotating the owner password.
   */
  private async loadProjectForDbCredentials(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      include: { infrastructure: { select: { pgAdminUser: true, pgAdminPassword: true } } },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamPermission(project.teamId, userId, 'canResetDbPassword');
    return project;
  }

  /**
   * Create the read-only companion role for an existing project, or repair it
   * (new password, grants refreshed) when it already exists.
   */
  async createReadonlyRole(projectId: string, userId: string) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    const target = this.provisioning.resolveAdminTarget(project);
    const readonlyRole = project.dbReadonlyUser || readonlyRoleNameFor(project.dbUser);
    // A repair keeps the credential clients already hold; only a first creation
    // (or a role whose password was lost) mints a new one. Rotation is explicit.
    const password =
      (project.dbReadonlyUser && project.dbReadonlyPassword) ||
      randomBytes(24).toString('base64url');

    let warnings: string[];
    try {
      ({ warnings } = await this.readonlyRole.provision({
        ...target,
        dbName: project.dbName,
        ownerUser: project.dbUser,
        readonlyRole,
        rolePassword: password,
      }));
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new InternalServerErrorException(`Failed to create read-only role: ${err.message}`);
    }

    await this.prisma.project.update({
      where: { id: project.id },
      data: { dbReadonlyUser: readonlyRole, dbReadonlyPassword: password },
    });
    await this.activity.append(project.id, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: project.dbReadonlyUser
        ? 'Read-only database role repaired'
        : 'Read-only database role created',
    });
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
    return { user: readonlyRole, password, warnings };
  }

  async rotateReadonlyPassword(projectId: string, userId: string, nextPassword?: string) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    if (!project.dbReadonlyUser) {
      throw new BadRequestException('This project has no read-only role yet');
    }
    // The rule is for a password someone chose; a generated one (32 random base64url characters)
    // often has no special character, and refusing it made rotation fail at random.
    const chosen = nextPassword?.trim();
    if (chosen) this.assertStrongDbPassword(chosen);
    const password = chosen || randomBytes(24).toString('base64url');
    const target = this.provisioning.resolveAdminTarget(project);
    try {
      await this.readonlyRole.setPassword({
        ...target,
        readonlyRole: project.dbReadonlyUser,
        rolePassword: password,
      });
    } catch (err: any) {
      throw new InternalServerErrorException(
        `Failed to rotate read-only password: ${err.message}`,
      );
    }
    await this.prisma.project.update({
      where: { id: project.id },
      data: { dbReadonlyPassword: password },
    });
    await this.activity.append(project.id, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: 'Read-only database password rotated',
    });
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
    return { password };
  }

  async dropReadonlyRole(projectId: string, userId: string) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    if (!project.dbReadonlyUser) {
      throw new BadRequestException('This project has no read-only role');
    }
    const target = this.provisioning.resolveAdminTarget(project);
    const { warnings } = await this.readonlyRole.drop({
      ...target,
      readonlyRole: project.dbReadonlyUser,
      dbName: project.dbName,
    });
    await this.prisma.project.update({
      where: { id: project.id },
      data: { dbReadonlyUser: null, dbReadonlyPassword: null },
    });
    await this.activity.append(project.id, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: 'Read-only database role removed',
    });
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
    return { message: 'Read-only role removed', warnings };
  }

  /* ─────────────────────────── Extra database roles ─────────────────────── */

  /**
   * The project's extra roles. Passwords are never in this answer: they are returned once when a
   * role is created or rotated, and afterwards only by the dashboard's credentials reveal.
   */
  async listExtraRoles(projectId: string, userId: string) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    const rows = await this.prisma.projectExtraRole.findMany({
      where: { projectId: project.id },
      select: SELECT_XR,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.extraRoleView(r));
  }

  /**
   * `memberOf` stays the stored string; `memberships` is the same as a list, `settings` the limits in ms.
   * `password` is null unless `password` is passed (the one answer of a create).
   */
  private extraRoleView<T extends { memberOf: string; settings?: unknown; kind?: string }>(row: T, password?: string) {
    const group = row.kind === 'group';
    const { password: _stored, ...rest } = row as T & { password?: unknown };
    return {
      ...rest,
      kind: group ? 'group' : 'login',
      // A group cannot log in: no password to show.
      password: group ? null : (password ?? null),
      memberships: memberOfFromColumn(row.memberOf),
      settings: (row.settings ?? {}) as ExtraRoleSettings,
    };
  }

  /** Audit entry for an extra role change: who (userId), the role's real name, the action. Never a password. */
  private async auditExtraRole(
    projectId: string,
    userId: string,
    action: ExtraRoleAuditAction,
    row: { label: string; roleName: string; kind?: string | null },
    title: string,
  ): Promise<void> {
    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: `${title}: ${row.label} (${row.roleName})`,
      metadata: { event: `db_role.${action}`, roleName: row.roleName, roleKind: row.kind === 'group' ? 'group' : 'login' },
    });
  }

  /** The role prefix and whether it can still change (no role uses it yet). */
  async getRolePrefix(projectId: string, userId: string) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    return { prefix: project.rolePrefix ?? null, locked: await this.rolePrefixLocked(project) };
  }

  private async rolePrefixLocked(project: { id: string; rolePrefix?: string | null }): Promise<boolean> {
    if (!project.rolePrefix) return false;
    const rows = await this.prisma.projectExtraRole.findMany({ where: { projectId: project.id }, select: { roleName: true } });
    return rows.some((r) => usesPrefix(project.rolePrefix, r.roleName));
  }

  /**
   * Choose the project's role prefix. Refused: an invalid or reserved value (400), a prefix another
   * project holds or that a cluster role this project does not manage already uses (409), and any
   * change once a role carries the current prefix (409).
   */
  async setRolePrefix(projectId: string, userId: string, input: unknown) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    const prefix = assertRolePrefix(typeof input === 'string' ? input.trim() : input);
    if (project.rolePrefix === prefix) return { prefix, locked: await this.rolePrefixLocked(project) };
    if (await this.rolePrefixLocked(project)) {
      throw new ConflictException(`The role prefix "${project.rolePrefix}" is in use by a role and can no longer change`);
    }
    const taken = await this.prisma.project.findFirst({
      where: { rolePrefix: { equals: prefix, mode: 'insensitive' }, NOT: { id: project.id } },
      select: { id: true },
    });
    if (taken) throw new ConflictException(`The role prefix "${prefix}" is taken`);
    const own = await this.prisma.projectExtraRole.findMany({ where: { projectId: project.id }, select: { roleName: true } });
    const target = this.provisioning.resolveAdminTarget(project);
    const foreign = foreignPrefixRoles(
      await this.extraRole.rolesMatchingPrefix(target, prefix),
      own.map((r) => r.roleName),
    );
    if (foreign.length) {
      throw new ConflictException(`The role prefix "${prefix}" is taken: database roles with that name already exist`);
    }
    try {
      await this.prisma.project.update({ where: { id: project.id }, data: { rolePrefix: prefix } });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictException(`The role prefix "${prefix}" is taken`);
      throw err;
    }
    await this.activity.append(project.id, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: `Database role prefix set: ${prefix}`,
      metadata: { event: 'db_role.prefix_set', prefix, previous: project.rolePrefix ?? null },
    });
    return { prefix, locked: false };
  }

  /**
   * Memberships a role may hold. A generated (`kb_xr_`) role keeps the original rule: the built-in
   * roles and the project's own groups. A named (`<prefix>_…`) role may only join the project's
   * own group roles: never anon, authenticated, service_role, the owner or another project's role.
   */
  private async allowedMemberships(
    project: { id: string; rolePrefix?: string | null },
    roleName: string,
    input: unknown,
  ): Promise<string[]> {
    const groups = (await this.projectGroupRoles(project.id)).filter((g) => g !== roleName);
    const members = parseMemberOf(input, groups);
    if (usesPrefix(project.rolePrefix, roleName)) {
      const builtIn = members.filter((m) => isBuiltInMember(m));
      if (builtIn.length) {
        throw new BadRequestException(
          `A named role can only be a member of this project's group roles, not ${builtIn.join(', ')}`,
        );
      }
    }
    return members;
  }

  /** Change the memberships or limits of an extra role; the role is re-provisioned with them. */
  async updateExtraRole(
    projectId: string,
    userId: string,
    roleId: string,
    input: { memberOf?: unknown; settings?: unknown },
  ) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    const row = await this.prisma.projectExtraRole.findFirst({ where: { id: roleId, projectId: project.id } });
    if (!row) throw new NotFoundException('Extra role not found');
    if (row.kind === 'group') {
      throw new BadRequestException('A group role has no memberships or limits to change; add login roles to it instead');
    }
    const members =
      input.memberOf === undefined
        ? memberOfFromColumn(row.memberOf)
        : await this.allowedMemberships(project, row.roleName, input.memberOf);
    const settings =
      input.settings === undefined
        ? parseRoleSettings(row.settings ?? {})
        : { ...parseRoleSettings(row.settings ?? {}), ...parseRoleSettings(input.settings) };
    // A null value in the request removes that limit.
    if (input.settings && typeof input.settings === 'object') {
      for (const [k, v] of Object.entries(input.settings as Record<string, unknown>)) {
        if (v === null) {
          const key = (Object.keys(parseRoleSettings({ [k]: 0 }))[0] ?? k) as keyof ExtraRoleSettings;
          delete settings[key];
        }
      }
    }
    const target = this.provisioning.resolveAdminTarget(project);
    try {
      await this.extraRole.provision({
        ...target,
        dbName: project.dbName,
        roleName: row.roleName,
        rolePassword: row.password,
        memberOf: members,
        settings,
      });
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new InternalServerErrorException(`Failed to update extra role: ${err.message}`);
    }
    const updated = await this.prisma.projectExtraRole.update({
      where: { id: roleId },
      data: { memberOf: memberOfColumn(members), settings: settings as any },
      select: SELECT_XR,
    });
    await this.auditExtraRole(project.id, userId, 'updated', row, 'Extra database role updated');
    return this.extraRoleView(updated);
  }

  /** The project's group role names, which login roles may join. */
  private async projectGroupRoles(projectId: string): Promise<string[]> {
    const rows = await this.prisma.projectExtraRole.findMany({
      where: { projectId, kind: 'group' },
      select: { roleName: true },
    });
    return rows.map((r) => r.roleName);
  }

  /**
   * The role's name: `<prefix>_<name>` when `name` is given (the project must have a prefix, and
   * the name must be free in the cluster), otherwise the generated `kb_xr_` / `kb_xg_` name.
   */
  private async extraRoleName(
    project: { id: string; rolePrefix?: string | null },
    kind: 'login' | 'group',
    nameInput: unknown,
  ): Promise<{ roleName: string; named: boolean }> {
    if (nameInput === undefined || nameInput === null || nameInput === '') {
      // Prefix + 10 random hex chars — unique across the shared cluster.
      return { roleName: (kind === 'group' ? 'kb_xg_' : 'kb_xr_') + randomBytes(5).toString('hex'), named: false };
    }
    if (!project.rolePrefix) {
      throw new BadRequestException(
        'Set a role prefix first (PUT /api/projects/:id/db-role-prefix), then name the role',
      );
    }
    const roleName = prefixedRoleName(project.rolePrefix, typeof nameInput === 'string' ? nameInput.trim() : nameInput);
    const dup = await this.prisma.projectExtraRole.findFirst({ where: { roleName }, select: { id: true } });
    if (dup) throw new ConflictException(`A database role named "${roleName}" already exists; choose another name`);
    return { roleName, named: true };
  }

  async createExtraRole(
    projectId: string,
    userId: string,
    label: string,
    memberOfInput: unknown,
    settingsInput?: unknown,
    kindInput?: unknown,
    nameInput?: unknown,
  ) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    const kind = kindInput === undefined || kindInput === null || kindInput === '' ? 'login' : String(kindInput);
    if (kind !== 'login' && kind !== 'group') throw new BadRequestException('kind must be "login" or "group"');
    const trimmedLabel = label?.trim();
    if (!trimmedLabel || trimmedLabel.length > 80) {
      throw new BadRequestException('Label must be 1–80 characters');
    }
    const existing = await this.prisma.projectExtraRole.count({ where: { projectId: project.id, kind } });
    if (existing >= MAX_EXTRA_ROLES_PER_KIND) {
      throw new BadRequestException(`Maximum of ${MAX_EXTRA_ROLES_PER_KIND} extra database ${kind} roles per project`);
    }
    const { roleName, named } = await this.extraRoleName(project, kind, nameInput);
    const target = this.provisioning.resolveAdminTarget(project);

    if (kind === 'group') {
      // A group has no password, no limits and no memberships of its own: it only owns and receives.
      if (parseMemberOf(memberOfInput, []).length) throw new BadRequestException('A group role is a member of nothing');
      if (Object.keys(parseRoleSettings(settingsInput)).length) {
        throw new BadRequestException('A group role cannot log in, so it has no run-time limits');
      }
      try {
        await this.extraRole.provisionGroup({ ...target, roleName, ownerRole: project.dbUser, mustNotExist: named });
      } catch (err: any) {
        if (err instanceof BadRequestException || err instanceof ConflictException) throw err;
        throw new InternalServerErrorException(`Failed to create group role: ${err.message}`);
      }
      const row = await this.prisma.projectExtraRole.create({
        data: { projectId: project.id, label: trimmedLabel, roleName, password: '', memberOf: 'none', kind: 'group' },
        select: SELECT_XR,
      });
      await this.auditExtraRole(project.id, userId, 'created', row, 'Database group role created');
      return this.extraRoleView(row);
    }

    const members = await this.allowedMemberships(project, roleName, memberOfInput);
    const settings = parseRoleSettings(settingsInput);
    const password = randomBytes(24).toString('base64url');

    try {
      await this.extraRole.provision({
        ...target,
        dbName: project.dbName,
        roleName,
        rolePassword: password,
        memberOf: members,
        settings,
        mustNotExist: named,
      });
    } catch (err: any) {
      if (err instanceof BadRequestException || err instanceof ConflictException) throw err;
      throw new InternalServerErrorException(`Failed to create extra role: ${err.message}`);
    }

    const row = await this.prisma.projectExtraRole.create({
      data: { projectId: project.id, label: trimmedLabel, roleName, password, memberOf: memberOfColumn(members), settings: settings as any, kind: 'login' },
      select: SELECT_XR,
    });
    await this.auditExtraRole(project.id, userId, 'created', row, 'Extra database role created');
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
    // The only answer that carries the password; store it now.
    return this.extraRoleView(row, password);
  }

  async rotateExtraRolePassword(
    projectId: string,
    userId: string,
    roleId: string,
    nextPassword?: string,
  ) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    const row = await this.prisma.projectExtraRole.findFirst({
      where: { id: roleId, projectId: project.id },
    });
    if (!row) throw new NotFoundException('Extra role not found');
    if (row.kind === 'group') throw new BadRequestException('A group role cannot log in, so it has no password');

    // The rule is for a password someone chose; a generated one (32 random base64url characters)
    // often has no special character, and refusing it made rotation fail at random.
    const chosen = nextPassword?.trim();
    if (chosen) this.assertStrongDbPassword(chosen);
    const password = chosen || randomBytes(24).toString('base64url');
    const target = this.provisioning.resolveAdminTarget(project);
    try {
      await this.extraRole.setPassword({ ...target, roleName: row.roleName, rolePassword: password });
    } catch (err: any) {
      throw new InternalServerErrorException(`Failed to rotate extra role password: ${err.message}`);
    }
    await this.prisma.projectExtraRole.update({
      where: { id: roleId },
      data: { password },
    });
    await this.auditExtraRole(project.id, userId, 'password_rotated', row, 'Extra database role password rotated');
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
    return { password };
  }

  async dropExtraRole(projectId: string, userId: string, roleId: string) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    const row = await this.prisma.projectExtraRole.findFirst({
      where: { id: roleId, projectId: project.id },
    });
    if (!row) throw new NotFoundException('Extra role not found');

    const target = this.provisioning.resolveAdminTarget(project);
    const group = row.kind === 'group';
    const { warnings } = await this.extraRole.drop({
      ...target,
      roleName: row.roleName,
      dbName: project.dbName,
      reassignTo: project.dbUser,
    });
    await this.prisma.projectExtraRole.delete({ where: { id: roleId } });
    if (group) {
      // DROP ROLE already removed the memberships in Postgres; keep the stored lists in step.
      const members = await this.prisma.projectExtraRole.findMany({ where: { projectId: project.id, kind: 'login' } });
      for (const m of members) {
        const list = memberOfFromColumn(m.memberOf);
        if (list.includes(row.roleName)) {
          await this.prisma.projectExtraRole.update({
            where: { id: m.id },
            data: { memberOf: memberOfColumn(list.filter((n) => n !== row.roleName)) },
          });
        }
      }
    }
    await this.auditExtraRole(project.id, userId, 'dropped', row, 'Extra database role removed');
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
    return { message: 'Extra role removed', warnings };
  }

  /**
   * Project teardown: drop every extra role of the project before its database goes, login roles
   * first, each with what it owns handed to the project owner. Never throws; failures are logged.
   */
  private async dropExtraRolesQuietly(project: { id: string; dbName: string; dbUser: string }): Promise<void> {
    let rows: Array<{ roleName: string; kind: string }>;
    try {
      rows = await this.prisma.projectExtraRole.findMany({ where: { projectId: project.id }, select: { roleName: true, kind: true } });
    } catch (err: any) {
      this.logger.warn(`Extra roles of project ${project.id} could not be listed for cleanup: ${err?.message || err}`);
      return;
    }
    rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? 1 : -1));
    const target = this.sharedAdminTarget();
    for (const r of rows) {
      try {
        const { warnings } = await this.extraRole.drop({ ...target, roleName: r.roleName, dbName: project.dbName, reassignTo: project.dbUser });
        for (const w of warnings) this.logger.warn(`Extra role "${r.roleName}" cleanup: ${w}`);
      } catch (err: any) {
        this.logger.warn(`Extra role "${r.roleName}" cleanup failed: ${err?.message || err}`);
      }
    }
  }

  /**
   * One-off, idempotent: REVOKE CONNECT … FROM PUBLIC on every live project database on the shared
   * cluster (new databases get it at creation). Not run automatically; an operator calls it.
   * Answers the databases that were open to PUBLIC before the call.
   */
  async revokePublicConnectOnProjectDatabases(): Promise<{ checked: number; wereOpen: string[]; failed: string[] }> {
    const projects = await this.prisma.project.findMany({
      where: { status: { not: 'DELETED' } },
      select: { dbName: true, dbHost: true, dbPort: true, infrastructure: { select: { pgAdminUser: true, pgAdminPassword: true } } },
    });
    const wereOpen: string[] = [];
    const failed: string[] = [];
    for (const p of projects) {
      try {
        if (await this.extraRole.revokePublicConnect(this.provisioning.resolveAdminTarget(p), p.dbName)) wereOpen.push(p.dbName);
      } catch {
        failed.push(p.dbName);
      }
    }
    return { checked: projects.length, wereOpen, failed };
  }

  /**
   * Per-database pooler cap. Null returns the project to its plan's value (or
   * the platform default); a number may not exceed what the plan allows.
   */
  async setMaxDbConnections(projectId: string, userId: string, value: number | null) {
    const project = await this.loadProjectForDbCredentials(projectId, userId);
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId: project.teamId },
      select: { plan: { select: { maxDbConnections: true } } },
    });
    const planMax = sub?.plan?.maxDbConnections ?? null;
    const planCeiling = this.pgbouncer.planCeiling(planMax);
    if (value !== null) {
      if (!Number.isInteger(value) || value < 1) {
        throw new BadRequestException(
          'Connection limit must be a whole number of at least 1, or null for the plan default',
        );
      }
      if (value > planCeiling) {
        throw new ForbiddenException(
          `Your current plan allows up to ${planCeiling} pooled connections per database. ` +
            'Upgrade your plan to raise this limit.',
        );
      }
    }
    await this.prisma.project.update({
      where: { id: project.id },
      data: { maxDbConnections: value },
    });
    const { effective, source } = this.pgbouncer.describeDbConnectionLimit({
      maxDbConnections: value,
      planMaxDbConnections: planMax,
    });
    await this.activity.append(project.id, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title:
        value === null
          ? 'Pooler connection limit reset to plan default'
          : `Pooler connection limit set to ${value}`,
    });
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
    return { maxDbConnections: value, planCeiling, effective, source };
  }

  /**
   * Raw DB + Keycloak fields for the import worker (internal host/port as stored — not PgBouncer external).
   */
  async getProjectForSupabaseImport(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      teamId: project.teamId,
      dbHost: project.dbHost,
      dbPort: project.dbPort,
      dbUser: project.dbUser,
      dbPassword: project.dbPassword,
      dbName: project.dbName,
      keycloakRealm: project.keycloakRealm,
    };
  }

  /** Repoint a project at a freshly-provisioned Keycloak realm (auth repair). */
  async updateKeycloakRealm(projectId: string, realmName: string): Promise<void> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { keycloakRealm: realmName },
    });
  }

  async findOne(id: string, userId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, status: { not: 'DELETED' } },
      include: {
        folder: { select: { id: true, name: true, color: true } },
        tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
        parent: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    if (userId) {
      await this.assertTeamMember(project.teamId, userId);
    }

    // No stored credential leaves the general read (#14): the database passwords, the service
    // key and the integration tokens. The dashboard reveals the connection credentials on
    // demand through POST /projects/:id/secrets/reveal.
    const { folder, tags, parent, ...rest } = project;
    const safe = stripProjectSecrets(rest);

    const externalHost = this.config.get<string>('pgbouncer.externalHost') || project.dbHost;
    const externalPort = this.config.get<number>('pgbouncer.externalPort') || project.dbPort;

    // The Overview "Last import" card: the newest finished import of any kind
    // (Supabase, ZIP, Data > Import Data).
    const lastImport = await this.prisma.projectActivityLog.findFirst({
      where: {
        projectId: id,
        OR: [
          { kind: { in: ['supabase_import.completed', 'project.zip_imported'] } },
          { title: { startsWith: 'Data import:' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    return {
      ...safe,
      lastImportAt: lastImport?.createdAt ?? null,
      // Set while the project's app still connects to the pooler without TLS (dashboard notice).
      dbTlsNoticeAt: project.dbTlsNoticeAt ?? null,
      folder,
      tags,
      previewBranch: previewBranchOf({ ...safe, parent }),
      dbHost: externalHost,
      dbPort: externalPort,
      github: project.githubOwner && project.githubRepo
        ? { connected: true, owner: project.githubOwner, repo: project.githubRepo, branch: project.githubBranch || 'main', repoUrl: `https://github.com/${project.githubOwner}/${project.githubRepo}` }
        : { connected: false },
      vercel: project.vercelProjectId
        ? { connected: true, projectId: project.vercelProjectId }
        : { connected: false },
    };
  }

  async moveToTeam(projectId: string, targetTeamId: string, userId: string) {
    // Load project and verify caller is a member of source team
    const project = await this.findOne(projectId, userId);

    // The source organization's OWNER may move; so may a role whose stored
    // canMoveProjects flag says so (the role-permissions page has shown it).
    const sourceMembership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!sourceMembership) {
      throw new ForbiddenException('You are not a member of this team');
    }
    if (
      sourceMembership.role !== 'OWNER' &&
      !(await grantedByRole(this.prisma, project.teamId, sourceMembership.role, 'canMoveProjects'))
    ) {
      throw new ForbiddenException('Only the source team owner can move projects');
    }

    // Caller must be a member of the target team
    const targetMembership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: targetTeamId, userId } },
    });
    if (!targetMembership) {
      throw new ForbiddenException('You are not a member of the target team');
    }

    if (project.teamId === targetTeamId) {
      throw new ForbiddenException('Project is already in this team');
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        teamId: targetTeamId,
        // Clear folder assignment since folders are team-specific
        folderId: null,
      },
    });

    this.logger.log(
      `Project "${project.name}" moved from team ${project.teamId} to team ${targetTeamId} by user ${userId}`,
    );

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.PROJECT_MOVED_TEAM,
      title: 'Project moved to another team',
      detail: `From team ${project.teamId} to ${targetTeamId}`,
      metadata: { fromTeamId: project.teamId, toTeamId: targetTeamId },
    });

    return { message: 'Project moved successfully' };
  }

  /** Per-plan ceiling for the Data grid's per-table row limit. */
  private static readonly ROW_LIMIT_CEILINGS: Record<string, number> = {
    free: 1000,
    pro: 10000,
    business: 100000,
    enterprise: 100000,
  };

  async setMaxRowsPerTable(projectId: string, userId: string, value: number) {
    const project = await this.findOne(projectId, userId);
    const ALLOWED = [1000, 10000, 100000];
    if (!ALLOWED.includes(value)) {
      throw new BadRequestException('Row limit must be 1,000, 10,000, or 100,000');
    }
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId: project.teamId },
      include: { plan: true },
    });
    const planFeatures = (sub?.plan?.features ?? null) as Record<string, unknown> | null;
    const planName =
      planFeatures && planFeatures.enterprise === true ? 'enterprise' : (sub?.plan?.name || 'free').toLowerCase();
    const ceiling = ProjectsService.ROW_LIMIT_CEILINGS[planName] ?? 1000;
    if (value > ceiling) {
      throw new ForbiddenException(
        `Your current plan allows up to ${ceiling.toLocaleString()} rows per table. ` +
          `Upgrade your plan to raise this limit.`,
      );
    }
    await this.prisma.project.update({
      where: { id: projectId },
      data: { maxRowsPerTable: value },
    });
    return { maxRowsPerTable: value, planCeiling: ceiling };
  }

  /**
   * The compute sizes the New project dialog may offer a team. Mirrors the rule
   * `create()` enforces: a dedicated size needs a plan that includes a dedicated
   * database and a region with room (today: the host's DEDICATED_DB_ENABLED).
   */
  async computeOptions(teamId: string, userId: string): Promise<ComputeOptions> {
    await this.assertTeamMember(teamId, userId);
    const plan = await this.quota.getTeamPlan(teamId);
    return computeOptionsFor({
      planDedicated: plan?.dedicatedDb === true,
      planDisplayName: plan?.displayName ?? 'Free',
      regionHasCapacity: this.infra.isDedicatedDbEnabled(),
    });
  }

  /**
   * What the project gets: region, compute, and how much of the plan's database and file
   * storage limits is used. Any member of the organization may read it. The database size
   * is re-measured when the stored figure is older than an hour, so the card is not
   * hours behind a freshly imported database.
   */
  async resources(projectId: string, userId: string): Promise<ProjectResources> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: {
        id: true,
        teamId: true,
        infrastructure: { select: { status: true, pgMemoryMb: true, pgCpuMillis: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);

    let usage = await this.prisma.projectUsage.findUnique({ where: { projectId } });
    const stale = !usage?.dbSizeCalculatedAt || Date.now() - usage.dbSizeCalculatedAt.getTime() > 60 * 60 * 1000;
    if (stale) {
      try {
        await this.usageService.refreshProjectDbSizes({ projectIds: [projectId] });
        usage = await this.prisma.projectUsage.findUnique({ where: { projectId } });
      } catch (err: any) {
        this.logger.debug(`Database size refresh for ${projectId} failed: ${err.message}`);
      }
    }
    const [plan, teamUsage] = await Promise.all([
      this.quota.getTeamPlan(project.teamId),
      this.prisma.teamUsage.findUnique({ where: { teamId: project.teamId } }),
    ]);

    return buildProjectResources({
      plan: plan
        ? {
            name: plan.name,
            displayName: plan.displayName,
            maxDbSizeBytes: plan.maxDbSizeBytes,
            maxStorageBytes: plan.maxStorageBytes,
          }
        : null,
      projectDbSizeBytes: usage?.dbSizeBytes ?? BigInt(0),
      projectStorageBytes: usage?.storageBytes ?? BigInt(0),
      dbSizeMeasuredAt: usage?.dbSizeCalculatedAt ?? null,
      storageMeasuredAt: usage?.storageCalculatedAt ?? null,
      orgDbSizeBytes: teamUsage?.dbSizeBytes ?? BigInt(0),
      orgStorageBytes: teamUsage?.storageBytes ?? BigInt(0),
      infrastructure: project.infrastructure,
    });
  }

  /**
   * Settings → Data access. Owners and admins only: turning automatic grants on
   * widens what the anon key can read. The database statements run first, so a
   * failure leaves the stored settings as they were.
   */
  async updateDataAccess(projectId: string, userId: string, body: UpdateDataAccessDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      include: { infrastructure: { select: { pgAdminUser: true, pgAdminPassword: true } } },
    });
    if (!project) throw new NotFoundException('Project not found');
    const role = await this.assertTeamMember(project.teamId, userId);
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new ForbiddenException('Only team owners and admins can change data access settings');
    }

    const before = dataAccessOf(project);
    const next: DataAccessFlags = {
      dataApi: body.dataApi ?? before.dataApi,
      autoGrantNewTables: body.autoGrantNewTables ?? before.autoGrantNewTables,
      rlsOnNewTables: body.rlsOnNewTables ?? before.rlsOnNewTables,
    };

    const sqlChanged =
      next.autoGrantNewTables !== before.autoGrantNewTables || next.rlsOnNewTables !== before.rlsOnNewTables;
    if (sqlChanged && project.databaseType === 'RELATIONAL') {
      const target = this.provisioning.resolveAdminTarget(project);
      const owner = project.dbUser.replace(/[^a-z0-9_]/g, '');
      const pool = new Pool({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: project.dbName.replace(/[^a-z0-9_]/g, ''),
      });
      try {
        await pool.query(renderDataAccessSql(owner, next));
      } catch (err: any) {
        this.logger.error(`Data access update failed for ${project.slug}: ${err?.message ?? err}`);
        throw new InternalServerErrorException(`Failed to apply data access settings: ${err?.message ?? err}`);
      } finally {
        await pool.end();
      }
    }

    await this.prisma.project.update({
      where: { id: project.id },
      data: {
        dataApiEnabled: next.dataApi,
        autoGrantNewTables: next.autoGrantNewTables,
        rlsOnNewTables: next.rlsOnNewTables,
      },
    });

    const changes: string[] = [];
    if (next.dataApi !== before.dataApi) changes.push(`Data API ${next.dataApi ? 'enabled' : 'disabled'}`);
    if (next.autoGrantNewTables !== before.autoGrantNewTables) {
      changes.push(`automatic grants on new tables ${next.autoGrantNewTables ? 'on' : 'off'}`);
    }
    if (next.rlsOnNewTables !== before.rlsOnNewTables) {
      changes.push(`RLS on new tables ${next.rlsOnNewTables ? 'on' : 'off'}`);
    }
    if (changes.length > 0) {
      await this.activity.append(project.id, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Data access settings changed',
        detail: changes.join(', '),
      });
    }
    return next;
  }

  /**
   * Settings → API: the schemas the REST data API serves (#264). `public` is always
   * served and listed first; `exposedSchemas` are the extras. Any team member may read it.
   */
  async getRestSchemas(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { id: true, teamId: true, restExposedSchemas: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);
    return restSchemasView(project.restExposedSchemas);
  }

  /**
   * Replace the extra exposed schemas. Owners and admins only: exposing a schema widens
   * what the API keys can address. It grants nothing in the database; the API roles still
   * need USAGE on the schema and privileges on its tables, and RLS applies.
   * System and platform schemas are refused.
   */
  async updateRestSchemas(projectId: string, userId: string, input: unknown) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { id: true, teamId: true, restExposedSchemas: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const role = await this.assertTeamMember(project.teamId, userId);
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new ForbiddenException('Only team owners and admins can change the exposed REST schemas');
    }
    let next: string[];
    try {
      next = validateExposedSchemas(input);
    } catch (err) {
      if (err instanceof ExposedSchemasError) throw new BadRequestException(err.message);
      throw err;
    }
    const before = project.restExposedSchemas ?? [];
    await this.prisma.project.update({
      where: { id: project.id },
      data: { restExposedSchemas: next },
    });
    if (before.join(',') !== next.join(',')) {
      await this.activity.append(project.id, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Exposed REST schemas changed',
        detail: next.length ? `public, ${next.join(', ')}` : 'public only',
      });
    }
    return restSchemasView(next);
  }

  async remove(
    id: string,
    userId: string,
    reason?: {
      reasonCode?: string;
      reasonLabel?: string;
      details?: string;
    },
  ) {
    const project = await this.findOne(id, userId);

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this team');
    }

    // Owners and creators could always delete; a role whose stored
    // canDeleteProjects flag says so now can too. Deleting moves the project
    // to the trash, where restore is available.
    const isCreator = project.createdBy === userId;
    if (
      membership.role !== 'OWNER' &&
      !isCreator &&
      !(await grantedByRole(this.prisma, project.teamId, membership.role, 'canDeleteProjects'))
    ) {
      throw new ForbiddenException('You can only delete projects you created');
    }

    const deletedName = await this.uniqueDeletedName(project.name);
    const deletedSlug = await this.uniqueDeletedSlug(project.slug);

    // Derive archived resource names (safe for DB identifier length limits)
    const suffix = `_del${Date.now()}`;
    const archivedDbName = `${project.dbName}${suffix}`.slice(0, 63);
    const archivedDbUser = `${project.dbUser}${suffix}`.slice(0, 63);

    // Rename DB + user so the original names are free for re-import immediately.
    // All data (tables, auth users, storage) remains intact for a potential restore.
    await this.renameDatabase(project.dbName, archivedDbName);

    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      await client.query(`ALTER USER "${project.dbUser.replace(/[^a-z0-9_]/g, '')}" RENAME TO "${archivedDbUser.replace(/[^a-z0-9_]/g, '')}"`);
    } catch (err: any) {
      this.logger.warn(`Soft-delete: could not rename db user: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }

    // Keycloak has no realm rename — the realm keeps its original name and is
    // only disabled here. The DB column must keep that real name too: writing
    // an "_del" archived name into it points every later admin call (restore,
    // auth export, hard delete) at a realm that never existed.
    try {
      await this.keycloak.disableRealm(project.keycloakRealm);
    } catch (err) {
      this.logger.warn(`Soft-delete: failed to disable Keycloak realm for "${project.name}": ${err}`);
    }

    await this.prisma.project.update({
      where: { id },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        name: deletedName,
        slug: deletedSlug,
        dbName: archivedDbName,
        dbUser: archivedDbUser,
      },
    });

    // A parent's preview branches go to the trash with it. Restoring the
    // parent does not bring them back; they are restored one by one if needed.
    if (!project.parentProjectId) {
      const liveBranches = await this.prisma.project.findMany({
        where: { parentProjectId: id, status: { not: 'DELETED' } },
        select: { id: true, name: true },
      });
      for (const child of liveBranches) {
        try {
          await this.remove(child.id, userId, {
            reasonCode: reason?.reasonCode || 'parent_deleted',
            reasonLabel: reason?.reasonLabel || 'Parent project deleted',
            details: reason?.details,
          });
        } catch (err: any) {
          this.logger.warn(
            `Preview branch "${child.name}" could not follow its parent to the trash: ${err?.message}`,
          );
        }
      }
    }

    // Branches are not counted, so there is nothing to give back for one.
    if (!project.parentProjectId) {
      this.usageService.decrementProjectCount(project.teamId).catch(() => {});
    }

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    this.logger.log(`Project "${project.name}" soft-deleted by user ${userId} (db: ${archivedDbName})`);

    // A missing reason is stored as "no reason", not as "None of the above" (#190).
    const pickedReason = normalizeDeletionReason(reason);
    await recordProjectDeletion(this.prisma, this.logger, {
      kind: 'trashed',
      project,
      actorUserId: userId,
      reason: pickedReason,
    });

    await this.activity.append(id, {
      userId,
      kind: ProjectActivityKind.PROJECT_DELETED,
      title: 'Project moved to trash',
      detail: project.name,
      metadata: {
        originalProjectName: project.name,
        reasonCode: pickedReason.reasonCode,
        reasonLabel: pickedReason.reasonLabel ?? NO_REASON_LABEL,
        details: pickedReason.details,
        // Marks rows that also have a deletion record, so the console list shows them once.
        deletionRecorded: true,
      },
    });

    // Realtime: everyone in the team should know a project is gone so their
    // sidebar / project picker can drop the entry without a refresh.
    {
      const memberIds = await this.teamMemberUserIds(project.teamId);
      const actorName = await this.resolveActorName(userId);
      await this.realtime.publish({
        entityType: 'project',
        action: 'deleted',
        entityId: id,
        actorUserId: userId,
        teamId: project.teamId,
        userIds: memberIds,
        payload: {
          name: project.name,
          actorName,
        },
      });
    }

    return { message: 'Project deleted' };
  }

  /**
   * "Deactivate" and "sleep" are one state now (`PAUSED`). The older
   * deactivation — a frozen project that gave up its plan slot and was purged
   * after 14 days — is gone: the owner's rule is that a deactivated project is
   * never deleted. The route stays so existing clients keep working.
   */
  async deactivate(id: string, userId: string) {
    return this.sleep(id, userId);
  }

  /**
   * Deactivate a project on request: the same state the idle sweep produces,
   * chosen deliberately. Its API answers nothing and its users cannot sign in
   * until it is activated again; nothing is deleted, the plan slot stays
   * taken, and a request carrying its key activates it again — a pause, not
   * a lock. No notice is sent: the person asking is the one who would get it.
   */
  async sleep(id: string, userId: string) {
    const project = await this.findOne(id, userId);

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this team');
    }
    const isCreator = project.createdBy === userId;
    if (membership.role !== 'OWNER' && !isCreator) {
      throw new ForbiddenException('You can only deactivate projects you created');
    }

    if (project.status === 'PAUSED') {
      return { message: 'Project is already deactivated' };
    }
    if (project.status !== 'ACTIVE') {
      throw new ForbiddenException('Only an active project can be deactivated');
    }

    // Flip only if it is still active, so two tabs racing deactivate it once.
    const { count } = await this.prisma.project.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { status: 'PAUSED', pausedAt: new Date(), idleWarningSentAt: null },
    });
    if (count === 0) {
      return { message: 'Project is already deactivated' };
    }

    // Close sign-in for the project's own users while it is deactivated. Best
    // effort: activation re-enables the realm regardless.
    await this.keycloak.disableRealm(project.keycloakRealm).catch((err: any) =>
      this.logger.warn(`Deactivate: realm not disabled for "${project.name}": ${err?.message ?? err}`),
    );

    // The pooler routes active projects only; drop this one from its config.
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    this.logger.log(`Project "${project.name}" deactivated by user ${userId}`);

    await this.activity.append(id, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: 'Project deactivated',
      detail:
        'A team member deactivated it from the dashboard. Its API stops answering until it is activated; ' +
        'nothing is deleted, and a request carrying its key activates it again.',
    });

    {
      const memberIds = await this.teamMemberUserIds(project.teamId);
      const actorName = await this.resolveActorName(userId);
      await this.realtime.publish({
        entityType: 'project',
        action: 'updated',
        entityId: id,
        actorUserId: userId,
        teamId: project.teamId,
        userIds: memberIds,
        payload: { name: project.name, status: 'PAUSED', actorName },
      });
    }

    return { message: 'Project deactivated' };
  }

  /**
   * Reactivate a deactivated project. This re-consumes a project slot, so the
   * plan quota is enforced — if the team is already at its limit the caller must
   * upgrade, or delete/deactivate another project first.
   */
  async reactivate(id: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.status !== 'DEACTIVATED' && project.status !== 'PAUSED') {
      throw new ForbiddenException('Project is not deactivated');
    }

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this team');
    }
    // Any member may activate: a deactivated project holds data the whole
    // organization is billed for, so reaching it is never gated beyond
    // membership (owner decision, 2026-10-26). Deactivating stays with the
    // owner and the creator.

    // Reactivating consumes a project slot again — enforce the plan quota with a
    // message that spells out the user's options. A sleeping project never
    // gave its slot up (PAUSED still counts against the plan), so waking one
    // can never be refused: a customer must always be able to reach data they
    // are already being billed for.
    try {
      if (project.status === 'DEACTIVATED') await this.quota.assertCanCreateProject(project.teamId);
    } catch (err) {
      if (err instanceof QuotaExceededException) {
        throw new QuotaExceededException(
          `Reactivating "${project.name}" would exceed your plan's project limit. ` +
            `Upgrade your plan, or delete or deactivate another project first.`,
          'projects',
        );
      }
      throw err;
    }

    // Sign-in comes back first, and the project only turns ACTIVE once it is
    // proven to work. enableRealm sends only {enabled:true}, so every user,
    // client and setting the realm kept while the project slept is untouched.
    let authRecreated = false;
    try {
      const realmName = project.keycloakRealm;
      const state = await this.keycloak.getRealmState(realmName);
      if (state === 'missing') {
        // Legacy case: the realm is really gone. Rebuild it with the same
        // bootstrap project creation uses (createRealm + createClients).
        await this.keycloak.createRealm(realmName);
        const clients = await this.keycloak.createClients(realmName);
        await this.prisma.project.update({
          where: { id },
          data: { anonKey: clients.anonKey, serviceKey: clients.serviceKey },
        });
        authRecreated = true;
      } else {
        if (state === 'disabled') await this.keycloak.enableRealm(realmName);
        if ((await this.keycloak.getRealmState(realmName)) !== 'enabled') {
          throw new Error('realm still disabled after enabling');
        }
      }
    } catch (err: any) {
      this.logger.error(`Reactivate: sign-in for "${project.name}" could not be restored: ${err?.message ?? err}`);
      await this.activity
        .append(id, {
          userId,
          kind: ProjectActivityKind.PROJECT_UPDATED,
          title: 'Reactivation failed',
          detail: 'Could not re-enable sign-in for this project; nothing was changed',
        })
        .catch(() => undefined);
      throw new BadGatewayException(
        'Could not re-enable sign-in for this project, try again; nothing was changed',
      );
    }

    await this.prisma.project.update({
      where: { id },
      data: { status: 'ACTIVE', deactivatedAt: null, pausedAt: null, idleWarningSentAt: null },
    });

    // Count waking as use. Without it the idle sweep would still read the old
    // stamp and could put a just-woken project straight back to sleep.
    await this.prisma.projectUsage
      .updateMany({ where: { projectId: id }, data: { lastRequestAt: new Date() } })
      .catch(() => undefined);

    // Only a deactivated project had released its slot.
    if (project.status === 'DEACTIVATED') {
      this.usageService.incrementProjectCount(project.teamId).catch(() => {});
    }
    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    this.logger.log(`Project "${project.name}" reactivated by user ${userId}`);

    await this.activity.append(id, {
      userId,
      kind: ProjectActivityKind.PROJECT_REACTIVATED,
      title: 'Project reactivated',
      detail: project.name,
    });
    if (authRecreated) {
      await this.activity.append(id, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Authentication recreated',
        detail: AUTH_RECREATED_MESSAGE,
      });
    }

    {
      const memberIds = await this.teamMemberUserIds(project.teamId);
      const actorName = await this.resolveActorName(userId);
      await this.realtime.publish({
        entityType: 'project',
        action: 'updated',
        entityId: id,
        actorUserId: userId,
        teamId: project.teamId,
        userIds: memberIds,
        payload: { name: project.name, status: 'ACTIVE', actorName },
      });
    }

    return { message: authRecreated ? AUTH_RECREATED_MESSAGE : 'Project reactivated' };
  }

  async listDeletionReasons(userId: string, limit = 200) {
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (actor?.role !== 'ROOT') {
      throw new ForbiddenException('Only ROOT can view project deletion reasons');
    }
    return listDeletionEntries(this.prisma, limit);
  }

  /**
   * Deleted projects the user can see. When `teamId` is omitted (the "All
   * Teams" view) this spans every team the user belongs to; each row carries
   * its `teamName` and a `canManage` flag (owner / admin / project creator)
   * so the UI can show ownership and gate restore / permanent-delete.
   */
  async findDeleted(teamId: string | undefined, userId: string) {
    await this.purgeDeletedProjectsPastRetention();

    const memberships = await this.prisma.teamMember.findMany({
      where: { userId, ...(teamId ? { teamId } : {}) },
      select: { teamId: true, role: true },
    });
    if (memberships.length === 0) return [];

    const roleByTeam = new Map(memberships.map((m) => [m.teamId, m.role]));
    const teamIds = memberships.map((m) => m.teamId);

    const projects = await this.prisma.project.findMany({
      where: { teamId: { in: teamIds }, status: 'DELETED' },
      orderBy: [{ deletedAt: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        createdBy: true,
        teamId: true,
        team: { select: { id: true, name: true } },
      },
    });

    return projects.map((p) => {
      const role = roleByTeam.get(p.teamId);
      const canManage =
        role === 'OWNER' || role === 'ADMIN' || p.createdBy === userId;
      const { team, createdBy, ...rest } = p;
      return {
        ...rest,
        // Show the clean original name, not the archived "..._del<ts>" form.
        name: this.stripDeletedSuffix(p.name),
        slug: this.stripDeletedSuffix(p.slug),
        teamId: p.teamId,
        teamName: team?.name ?? null,
        createdBy,
        canManage,
      };
    });
  }

  /**
   * Deactivated projects for a team — the "Deactivated" list. `PAUSED` is
   * the state; the legacy `DEACTIVATED` rows are listed alongside until they
   * are activated, and nothing in this list is ever purged.
   */
  async findDeactivated(teamId: string | undefined, userId: string) {
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId, ...(teamId ? { teamId } : {}) },
      select: { teamId: true, role: true },
    });
    if (memberships.length === 0) return [];

    const roleByTeam = new Map(memberships.map((m) => [m.teamId, m.role]));
    const teamIds = memberships.map((m) => m.teamId);

    const projects = await this.prisma.project.findMany({
      where: { teamId: { in: teamIds }, status: { in: ['PAUSED', 'DEACTIVATED'] } },
      orderBy: [{ pausedAt: 'desc' }, { deactivatedAt: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        deactivatedAt: true,
        pausedAt: true,
        createdBy: true,
        teamId: true,
        team: { select: { id: true, name: true } },
      },
    });

    return projects.map((p) => {
      const role = roleByTeam.get(p.teamId);
      const canManage =
        role === 'OWNER' || role === 'ADMIN' || p.createdBy === userId;
      const { team, pausedAt, ...rest } = p;
      return {
        ...rest,
        // The list shows one "deactivated since" date whichever path got the
        // project here.
        deactivatedAt: rest.deactivatedAt ?? pausedAt,
        teamName: team?.name ?? null,
        canManage,
      };
    });
  }

  /**
   * A deleted project may be restored or permanently removed by the team
   * owner, a team admin, or the user who created the project.
   */
  private async assertCanManageDeleted(
    project: { teamId: string; createdBy: string | null },
    userId: string,
    /** A stored flag that also grants this action to a role (e.g. canRestoreProjects). */
    grantedBy?: PermissionKey,
  ): Promise<void> {
    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this team');
    }
    if (
      membership.role === 'OWNER' ||
      membership.role === 'ADMIN' ||
      project.createdBy === userId
    ) {
      return;
    }
    if (grantedBy && (await grantedByRole(this.prisma, project.teamId, membership.role, grantedBy))) {
      return;
    }
    throw new ForbiddenException(
      'Only the team owner, a team admin, or the project creator can do this',
    );
  }

  async restore(id: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.status !== 'DELETED') {
      throw new ForbiddenException('Project is not deleted');
    }

    await this.assertCanManageDeleted(project, userId, 'canRestoreProjects');

    const originalName = this.stripDeletedSuffix(project.name);
    const originalSlug = this.stripDeletedSuffix(project.slug);

    // Name uniqueness is per-team: other teams may freely share project names.
    const nameConflict = await this.prisma.project.findFirst({
      where: {
        name: { equals: originalName, mode: 'insensitive' },
        teamId: project.teamId,
        id: { not: project.id },
        status: { not: 'DELETED' },
      },
      select: { id: true },
    });
    if (nameConflict) {
      throw new ForbiddenException(
        `A project named "${originalName}" already exists in this team. Delete or rename it before restoring this one.`,
      );
    }

    // Slugs are global. If the original got taken while this project sat in
    // the trash, mint a fresh one and freeze the storage prefix to the
    // pre-delete slug so existing buckets stay reachable.
    let restoredSlug = originalSlug;
    const slugTaken = await this.prisma.project.findFirst({
      where: { slug: originalSlug, id: { not: project.id } },
      select: { id: true },
    });
    if (slugTaken) {
      restoredSlug = await this.uniqueSlug(originalSlug);
    }

    // Derive the original DB name / user / realm from the archived names
    // e.g. "kb_usgourmet_del1234567890" → "kb_usgourmet"
    const originalDbName = project.dbName.replace(/_del\d+$/, '');
    const originalDbUser = project.dbUser.replace(/_del\d+$/, '');
    // Legacy rows from before the realm-reference fix accumulated one "_del"
    // suffix per trash/restore cycle (the realm itself never carried them) —
    // strip them all.
    const originalRealm  = project.keycloakRealm.replace(/(_del\d+)+$/, '');

    // Restore database and user names
    await this.renameDatabase(project.dbName, originalDbName);

    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      const sanitizedCurrent = project.dbUser.replace(/[^a-z0-9_]/g, '');
      const sanitizedOriginal = originalDbUser.replace(/[^a-z0-9_]/g, '');
      if (sanitizedCurrent !== sanitizedOriginal) {
        await client.query(`ALTER USER "${sanitizedCurrent}" RENAME TO "${sanitizedOriginal}"`);
      }
    } catch (err: any) {
      this.logger.warn(`Restore: could not rename db user back: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }

    // Re-enable the Keycloak realm. Keycloak has no rename, so the realm kept
    // its original name while trashed; legacy trash rows (from before this fix)
    // carry an "_del" suffix in the column that the realm itself never had.
    let restoredRealm = originalRealm;
    try {
      if (await this.keycloak.realmExists(originalRealm)) {
        await this.keycloak.enableRealm(originalRealm);
      } else if (await this.keycloak.realmExists(project.keycloakRealm)) {
        restoredRealm = project.keycloakRealm;
        await this.keycloak.enableRealm(restoredRealm);
      } else {
        this.logger.warn(
          `Restore: Keycloak realm "${originalRealm}" not found; auth for this project needs re-provisioning`,
        );
      }
    } catch (err) {
      this.logger.warn(`Restore: could not re-enable Keycloak realm: ${err}`);
    }

    const restoredStoragePrefix =
      restoredSlug !== originalSlug && !project.storagePrefix
        ? await this.uniqueStoragePrefix(originalSlug, id)
        : undefined;
    await this.prisma.project.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        deletedAt: null,
        name: originalName,
        slug: restoredSlug,
        ...(restoredStoragePrefix ? { storagePrefix: restoredStoragePrefix } : {}),
        dbName: originalDbName,
        dbUser: originalDbUser,
        keycloakRealm: restoredRealm,
      },
    });

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    this.logger.log(`Project "${originalName}" restored by user ${userId}`);

    await this.activity.append(id, {
      userId,
      kind: ProjectActivityKind.PROJECT_RESTORED,
      title: 'Project restored from trash',
      detail: originalName,
    });

    await recordProjectDeletion(this.prisma, this.logger, {
      kind: 'restored',
      project,
      actorUserId: userId,
    });

    {
      const restoredProject = await this.prisma.project.findUnique({
        where: { id },
        select: { teamId: true, name: true },
      });
      if (restoredProject) {
        const memberIds = await this.teamMemberUserIds(restoredProject.teamId);
        const actorName = await this.resolveActorName(userId);
        await this.realtime.publish({
          entityType: 'project',
          action: 'restored',
          entityId: id,
          actorUserId: userId,
          teamId: restoredProject.teamId,
          userIds: memberIds,
          payload: {
            name: restoredProject.name,
            actorName,
          },
        });
      }
    }

    return { message: 'Project restored' };
  }

  async permanentDelete(id: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.status !== 'DELETED') {
      throw new ForbiddenException('Only deleted projects can be permanently removed');
    }

    await this.assertCanManageDeleted(project, userId);

    // Tearing down the realm + database can take longer than the client's HTTP
    // timeout, which surfaced as an intermittent "Backend unreachable" (the work
    // actually completed, so a retry "succeeded"). Run it in the background and
    // return immediately. The row stays until teardown finishes; if teardown
    // fails it's left in trash and the hourly purge cron retries it later.
    void this.performPermanentTeardown(project, userId).catch((err) =>
      this.logger.error(`Background teardown failed for "${project.name}" (${id}): ${err}`),
    );

    return { message: 'Project deletion started', status: 'deleting' };
  }

  /** Heavy teardown for a permanently-deleted project: realm, database, row. */
  private async performPermanentTeardown(
    project: {
      id: string;
      name: string;
      slug?: string | null;
      teamId?: string | null;
      parentProjectId?: string | null;
      keycloakRealm: string;
      dbName: string;
      dbUser: string;
      dbReadonlyUser?: string | null;
    },
    userId?: string,
  ): Promise<void> {
    await this.deleteProjectRealm(project.keycloakRealm);
    await this.dropExtraRolesQuietly(project);
    await this.dropDatabase(project.dbName).catch(() => {});
    await this.dropDatabaseUser(project.dbUser).catch(() => {});
    await this.dropReadonlyRoleQuietly(project.dbReadonlyUser);

    // Read before the delete: the activity rows cascade away with the project.
    const reason = await lastTrashReason(this.prisma, project.id);
    await this.prisma.project.delete({ where: { id: project.id } });
    await recordProjectDeletion(this.prisma, this.logger, {
      kind: 'permanent',
      project,
      actorUserId: userId ?? null,
      reason,
    });

    this.logger.log(
      `Project "${project.name}" permanently deleted${userId ? ` by user ${userId}` : ''}`,
    );

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
  }

  /**
   * Delete a project's Keycloak realm, tolerating legacy trash rows whose
   * column carries an "_del" archived suffix the realm itself never had —
   * those rows must still delete the realm under its real (stripped) name,
   * otherwise the disabled realm leaks in Keycloak forever.
   */
  private async deleteProjectRealm(realmName: string): Promise<void> {
    const candidates = [...new Set([realmName, realmName.replace(/(_del\d+)+$/, '')])];
    for (const name of candidates) {
      try {
        await this.keycloak.deleteRealm(name);
        return;
      } catch (err) {
        this.logger.warn(`Realm cleanup: could not delete "${name}": ${err}`);
      }
    }
  }

  async forceDelete(id: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) return;

    // Mark it dead before tearing anything down. This teardown has been
    // interrupted part-way — a deploy restarting the container between dropping
    // the database and removing the row — and left an ACTIVE project pointing at
    // a database that no longer exists: broken to open, and invisible to the
    // cleanup that only looks at DELETED rows. Ordering it this way means an
    // interruption leaves something recoverable instead.
    await this.prisma.project
      .update({ where: { id }, data: { status: 'DELETED', deletedAt: new Date() } })
      .catch(() => undefined);

    // A failure here must not strand the rest of the teardown.
    await this.deleteProjectRealm(project.keycloakRealm).catch((err) =>
      this.logger.warn(`Realm cleanup failed for "${project.name}": ${err.message}`),
    );

    await this.dropExtraRolesQuietly(project);
    await this.dropDatabase(project.dbName).catch(() => {});
    await this.dropDatabaseUser(project.dbUser).catch(() => {});
    await this.dropReadonlyRoleQuietly(project.dbReadonlyUser);

    await this.prisma.project.delete({ where: { id } });

    this.logger.log(`Project "${project.name}" force-deleted (cancelled import)`);

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
  }

  /** Permanently remove soft-deleted projects past the 24-hour retention window. */
  private async purgeDeletedProjectsPastRetention(): Promise<number> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS);

    const expired = await this.prisma.project.findMany({
      where: {
        status: 'DELETED',
        OR: [
          { deletedAt: { lt: cutoff } },
          { AND: [{ deletedAt: null }, { updatedAt: { lt: cutoff } }] },
        ],
      },
    });

    if (expired.length === 0) {
      return 0;
    }

    this.logger.log(
      `Trash cleanup: permanently deleting ${expired.length} project(s) past 24h retention`,
    );

    for (const project of expired) {
      try {
        await this.deleteProjectRealm(project.keycloakRealm);

        await this.dropExtraRolesQuietly(project);
        await this.dropDatabase(project.dbName).catch(() => {});
        await this.dropDatabaseUser(project.dbUser).catch(() => {});
        await this.dropReadonlyRoleQuietly(project.dbReadonlyUser);

        const reason = await lastTrashReason(this.prisma, project.id);
        await this.prisma.project.delete({ where: { id: project.id } });
        // No actor: the retention purge did it.
        await recordProjectDeletion(this.prisma, this.logger, { kind: 'permanent', project, reason });

        this.logger.log(`Cleanup: permanently deleted "${project.name}"`);
      } catch (err: any) {
        this.logger.error(`Cleanup: failed to delete project "${project.name}": ${err.message}`);
      }
    }

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed after cleanup: ${err}`),
    );

    return expired.length;
  }

  // A deactivated project is never purged. The 14-day cleanup that used to
  // live here is gone on purpose: only the trash (`DELETED`) expires.
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredDeletedProjects() {
    const n = await this.purgeDeletedProjectsPastRetention();
    if (n > 0) {
      this.logger.log(`Trash cleanup: removed ${n} expired project(s) past 24h retention`);
    }
  }

  private async assertTeamMember(teamId: string, userId: string) {
    if (!teamId) throw new ForbiddenException('No team specified');
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
    return m.role;
  }

  /** A flag that has always been enforced (canResetDbPassword): the stored row, else the role defaults. */
  private async assertTeamPermission(
    teamId: string,
    userId: string,
    permission: PermissionKey,
  ) {
    if (!teamId) throw new ForbiddenException('No team specified');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a member of this team');

    if (!(await roleAllows(this.prisma, teamId, member.role, permission))) {
      throw new ForbiddenException(
        `Your role does not have the "${permission}" permission in this team`,
      );
    }
  }

  private assertStrongDbPassword(password: string) {
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    if (!/[a-z]/.test(password)) {
      throw new BadRequestException('Password must include a lowercase letter');
    }
    if (!/[A-Z]/.test(password)) {
      throw new BadRequestException('Password must include an uppercase letter');
    }
    if (!/[0-9]/.test(password)) {
      throw new BadRequestException('Password must include a number');
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      throw new BadRequestException('Password must include a special character');
    }
    if (/\s/.test(password)) {
      throw new BadRequestException('Password must not contain spaces');
    }
  }

  private async renameDatabase(oldName: string, newName: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    const sanitizedOld = oldName.replace(/[^a-z0-9_]/g, '');
    const sanitizedNew = newName.replace(/[^a-z0-9_]/g, '');
    try {
      // Terminate all active connections to the DB before renaming
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [sanitizedOld],
      );
      await client.query(`ALTER DATABASE "${sanitizedOld}" RENAME TO "${sanitizedNew}"`);
      this.logger.log(`Database renamed: "${sanitizedOld}" → "${sanitizedNew}"`);
    } catch (err: any) {
      this.logger.warn(`Failed to rename database "${sanitizedOld}" to "${sanitizedNew}": ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async createDatabase(dbName: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      const sanitized = dbName.replace(/[^a-z0-9_]/g, '');
      await client.query(`CREATE DATABASE "${sanitized}"`);
      await client.query(`REVOKE CONNECT ON DATABASE "${sanitized}" FROM PUBLIC`);
      this.logger.log(`Database "${sanitized}" created (public connect revoked)`);
    } catch (err: any) {
      if (err.code === '42P04') {
        this.logger.warn(`Database "${dbName}" already exists`);
        return;
      }
      throw new InternalServerErrorException('Failed to create database');
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async createDatabaseUser(username: string, password: string, dbName: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    const sanitizedUser = username.replace(/[^a-z0-9_]/g, '');
    const sanitizedDb = dbName.replace(/[^a-z0-9_]/g, '');

    try {
      await client.query(`CREATE USER "${sanitizedUser}" WITH PASSWORD '${password.replace(/'/g, "''")}'`);
      await client.query(`GRANT CONNECT ON DATABASE "${sanitizedDb}" TO "${sanitizedUser}"`);
      // Hosted vendor CLI / Prisma migrate may create migration schemas — needs DB-level CREATE.
      await client.query(`GRANT CREATE ON DATABASE "${sanitizedDb}" TO "${sanitizedUser}"`);
      this.logger.log(`User "${sanitizedUser}" created`);
    } catch (err: any) {
      if (err.code === '42710') {
        this.logger.warn(`User "${sanitizedUser}" already exists`);
        return;
      }
      throw new InternalServerErrorException(`Failed to create database user: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }

    const projectPool = new Pool({
      host: this.config.get('database.host'),
      port: this.config.get('database.port'),
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: sanitizedDb,
    });
    const projectClient = await projectPool.connect();
    try {
      await projectClient.query(`GRANT ALL PRIVILEGES ON SCHEMA public TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO "${sanitizedUser}"`);
    } finally {
      projectClient.release();
      await projectPool.end();
    }
  }

  private async dropDatabaseUser(username: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    const sanitized = username.replace(/[^a-z0-9_]/g, '');
    try {
      await client.query(`DROP USER IF EXISTS "${sanitized}"`);
      this.logger.log(`User "${sanitized}" dropped`);
    } catch (err: any) {
      this.logger.warn(`Failed to drop user "${sanitized}": ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async dropDatabase(dbName: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      const sanitized = dbName.replace(/[^a-z0-9_]/g, '');
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [sanitized],
      );
      await client.query(`DROP DATABASE IF EXISTS "${sanitized}"`);
      this.logger.log(`Database "${sanitized}" dropped`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async createDatabaseOnHost(
    dbName: string,
    host: string,
    port: number,
    adminUser: string,
    adminPassword: string,
  ) {
    const pool = new Pool({ host, port, user: adminUser, password: adminPassword, database: 'postgres' });
    const client = await pool.connect();
    try {
      const sanitized = dbName.replace(/[^a-z0-9_]/g, '');
      await client.query(`CREATE DATABASE "${sanitized}"`);
      await client.query(`REVOKE CONNECT ON DATABASE "${sanitized}" FROM PUBLIC`);
      this.logger.log(`Database "${sanitized}" created on ${host} (public connect revoked)`);
    } catch (err: any) {
      if (err.code === '42P04') {
        this.logger.warn(`Database "${dbName}" already exists on ${host}`);
        return;
      }
      throw new InternalServerErrorException('Failed to create database');
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async createDatabaseUserOnHost(
    username: string,
    password: string,
    dbName: string,
    host: string,
    port: number,
    adminUser: string,
    adminPassword: string,
  ) {
    const pool = new Pool({ host, port, user: adminUser, password: adminPassword, database: 'postgres' });
    const client = await pool.connect();
    const sanitizedUser = username.replace(/[^a-z0-9_]/g, '');
    const sanitizedDb = dbName.replace(/[^a-z0-9_]/g, '');
    try {
      await client.query(`CREATE USER "${sanitizedUser}" WITH PASSWORD '${password.replace(/'/g, "''")}'`);
      await client.query(`GRANT CONNECT ON DATABASE "${sanitizedDb}" TO "${sanitizedUser}"`);
      await client.query(`GRANT CREATE ON DATABASE "${sanitizedDb}" TO "${sanitizedUser}"`);
      this.logger.log(`User "${sanitizedUser}" created on ${host}`);
    } catch (err: any) {
      if (err.code === '42710') {
        this.logger.warn(`User "${sanitizedUser}" already exists on ${host}`);
        return;
      }
      throw new InternalServerErrorException(`Failed to create database user: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }

    const projectPool = new Pool({ host, port, user: adminUser, password: adminPassword, database: sanitizedDb });
    const projectClient = await projectPool.connect();
    try {
      await projectClient.query(`GRANT ALL PRIVILEGES ON SCHEMA public TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO "${sanitizedUser}"`);
    } finally {
      projectClient.release();
      await projectPool.end();
    }
  }

  /**
   * Ensures the project DB role can create schemas for vendor migration tooling / Prisma migrate.
   * Idempotent. Only applies on the shared control-plane Postgres (matches POSTGRES_HOST/PORT in env).
   */
  async ensureProjectMigrationGrants(
    projectId: string,
    userId?: string,
    opts?: { skipTeamAssert?: boolean },
  ): Promise<void> {
    if (!userId && !opts?.skipTeamAssert) {
      return;
    }
    const row = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: {
        teamId: true,
        dbHost: true,
        dbPort: true,
        dbUser: true,
        dbName: true,
      },
    });
    if (!row) return;
    if (userId) {
      await this.assertTeamMember(row.teamId, userId);
    }
    const cfgHost = this.config.get<string>('database.host')!;
    const cfgPort = Number(this.config.get<number>('database.port'));
    if (row.dbHost !== cfgHost || Number(row.dbPort) !== cfgPort) {
      return;
    }
    const sanitizedDb = row.dbName.replace(/[^a-z0-9_]/g, '');
    const sanitizedUser = row.dbUser.replace(/[^a-z0-9_]/g, '');
    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      await client.query(`GRANT CREATE ON DATABASE "${sanitizedDb}" TO "${sanitizedUser}"`);
    } catch (err: any) {
      this.logger.warn(
        `ensureProjectMigrationGrants failed for ${projectId}: ${err?.message || err}`,
      );
    } finally {
      client.release();
      await pool.end();
    }
  }

  private getAdminPool(): Pool {
    return new Pool({
      host: this.config.get('database.host'),
      port: this.config.get('database.port'),
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: 'postgres',
    });
  }

  /** The platform's own admin credentials for the shared cluster. */
  private sharedAdminTarget(): AdminTarget {
    return {
      host: this.config.get<string>('database.host')!,
      port: Number(this.config.get<number>('database.port')),
      user: this.config.get<string>('database.user')!,
      password: this.config.get<string>('database.password')!,
    };
  }

  /**
   * Read-only companion role for a freshly created database. Never fatal: a
   * project is worth more than its reporting credential, and the Connection
   * page can create the role later.
   */
  private async provisionReadonlyRole(
    target: AdminTarget,
    dbName: string,
    ownerUser: string,
  ): Promise<{ user: string; password: string } | null> {
    if (this.config.get<boolean>('provisioning.readonlyRole') === false) return null;
    const readonlyRole = readonlyRoleNameFor(ownerUser);
    const password = randomBytes(24).toString('base64url');
    try {
      await this.readonlyRole.provision({ ...target, dbName, ownerUser, readonlyRole, rolePassword: password });
      return { user: readonlyRole, password };
    } catch (err: any) {
      this.logger.error(
        `Read-only role for "${dbName}" could not be created: ${err?.message || err}`,
      );
      return null;
    }
  }

  /** Teardown helper: the companion role is cluster-level, so it outlives DROP DATABASE. */
  private async dropReadonlyRoleQuietly(readonlyRole: string | null | undefined): Promise<void> {
    if (!readonlyRole) return;
    await this.readonlyRole
      .drop({ ...this.sharedAdminTarget(), readonlyRole })
      .catch((err) =>
        this.logger.warn(`Read-only role "${readonlyRole}" cleanup failed: ${err?.message || err}`),
      );
  }

  /* ─────────────────────────── RLS bootstrap ─────────────────────────── */

  private _rlsBootstrapSqlCache: string | null = null;

  private loadRlsBootstrapSql(): string {
    if (this._rlsBootstrapSqlCache) return this._rlsBootstrapSqlCache;
    // At runtime (after `nest build`) this file lives next to the compiled
    // projects.service.js under sql/rls-bootstrap.sql. During `start:dev`
    // (ts-node) __dirname is the ts source folder. Both paths work.
    const candidate = join(__dirname, 'sql', 'rls-bootstrap.sql');
    const sql = readFileSync(candidate, 'utf8');
    this._rlsBootstrapSqlCache = sql;
    return sql;
  }

  /**
   * Install anon/authenticated/service_role roles, the `auth` schema and
   * helper functions into a project DB on the shared/control-plane Postgres.
   * Idempotent — safe to call on existing databases.
   */
  /**
   * The advisor's starter tables (#240), created as the project owner so the project's
   * grants and default privileges apply as to any table the owner makes. Best-effort: a
   * failure is logged and reported in the activity feed; the project itself is ready.
   */
  private async createStarterTables(
    projectId: string,
    userId: string,
    target: AdminTarget,
    dbName: string,
    dbUser: string,
    key: StarterKey,
  ): Promise<void> {
    const owner = dbUser.replace(/[^a-z0-9_]/g, '');
    const pool = new Pool({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: dbName.replace(/[^a-z0-9_]/g, ''),
      max: 1,
      statement_timeout: 30_000,
    });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE "${owner}"`);
        for (const stmt of starterSql(key)) await client.query(stmt);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      await this.activity.append(projectId, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: `Starter tables created: ${starterTables(key).join(', ')}`,
      });
    } catch (err: any) {
      this.logger.warn(`Starter tables (${key}) for ${projectId} failed: ${err?.message ?? err}`);
      await this.activity
        .append(projectId, {
          userId,
          kind: ProjectActivityKind.PROJECT_UPDATED,
          title: 'Starter tables could not be created',
          detail: 'The project is ready but empty. Create the tables from the SQL editor.',
        })
        .catch(() => undefined);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  async applyRlsBootstrap(
    dbName: string,
    dbUser: string,
    flags: DataAccessFlags = withDataAccessDefaults(),
  ): Promise<void> {
    const sanitizedDb = dbName.replace(/[^a-z0-9_]/g, '');
    const sanitizedUser = dbUser.replace(/[^a-z0-9_]/g, '');

    const pool = new Pool({
      host: this.config.get('database.host'),
      port: this.config.get('database.port'),
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: sanitizedDb,
    });
    try {
      await this.runRlsBootstrap(pool, sanitizedUser, flags);
      this.logger.log(`RLS bootstrap applied to "${sanitizedDb}"`);
    } catch (err: any) {
      this.logger.error(
        `RLS bootstrap failed for "${sanitizedDb}": ${err.message}`,
        err.stack,
      );
      throw new InternalServerErrorException(
        `Failed to apply RLS bootstrap: ${err.message}`,
      );
    } finally {
      await pool.end();
    }
  }

  /** Same as applyRlsBootstrap but targets a dedicated-host DB. */
  async applyRlsBootstrapOnHost(
    dbName: string,
    dbUser: string,
    host: string,
    port: number,
    adminUser: string,
    adminPassword: string,
    flags: DataAccessFlags = withDataAccessDefaults(),
  ): Promise<void> {
    const sanitizedDb = dbName.replace(/[^a-z0-9_]/g, '');
    const sanitizedUser = dbUser.replace(/[^a-z0-9_]/g, '');

    const pool = new Pool({
      host,
      port,
      user: adminUser,
      password: adminPassword,
      database: sanitizedDb,
    });
    try {
      await this.runRlsBootstrap(pool, sanitizedUser, flags);
      this.logger.log(`RLS bootstrap applied to "${sanitizedDb}" on ${host}`);
    } catch (err: any) {
      this.logger.error(
        `RLS bootstrap failed for "${sanitizedDb}" on ${host}: ${err.message}`,
        err.stack,
      );
      throw new InternalServerErrorException(
        `Failed to apply RLS bootstrap: ${err.message}`,
      );
    } finally {
      await pool.end();
    }
  }

  /**
   * Put back whatever a live project is missing underneath it.
   *
   * Two projects were found ACTIVE in the dashboard with no database at all:
   * every request against them failed and their nightly backup had been
   * failing for months. Creation is transactional today — the row is written
   * only once the database and the realm both exist — so nothing creates that
   * state any more, but the projects left in it had no way back short of
   * hand-written SQL on the server.
   *
   * Only ever additive: each step first asks whether the thing is already
   * there. A project with everything in place comes back with an empty
   * `created` list, so this is safe to run twice.
   *
   * Recreating the realm issues new clients, so the project's anon and service
   * keys change and anything holding the old ones must be updated. That is
   * reported in the result rather than hidden.
   */
  async repairProvisioning(projectId: string): Promise<{
    projectId: string;
    created: string[];
    alreadyPresent: string[];
    keysRotated: boolean;
  }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: {
        id: true,
        slug: true,
        dbName: true,
        dbHost: true,
        dbPort: true,
        dbUser: true,
        dbPassword: true,
        keycloakRealm: true,
        autoGrantNewTables: true,
        rlsOnNewTables: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const cfgHost = this.config.get<string>('database.host');
    const cfgPort = Number(this.config.get<number>('database.port'));
    if (project.dbHost !== cfgHost || Number(project.dbPort) !== cfgPort) {
      // A dedicated project's database lives inside its own container, whose
      // admin credentials this service does not hold.
      throw new BadRequestException(
        'This project runs on a dedicated database host; repair it through the provisioning flow',
      );
    }

    const created: string[] = [];
    const alreadyPresent: string[] = [];

    const pool = this.getAdminPool();
    const existing = await pool.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      [project.dbName],
    );
    if (existing.rowCount === 0) {
      await this.createDatabase(project.dbName);
      await this.createDatabaseUser(project.dbUser, project.dbPassword, project.dbName);
      await this.applyRlsBootstrap(project.dbName, project.dbUser, dataAccessOf(project));
      created.push('database', 'database user', 'row-level security bootstrap');
      this.logger.warn(`Repaired missing database "${project.dbName}" for project ${project.slug}`);
    } else {
      alreadyPresent.push('database');
    }

    let keysRotated = false;
    if (project.keycloakRealm) {
      const realmThere = await this.keycloak.realmExists(project.keycloakRealm).catch(() => true);
      if (!realmThere) {
        await this.keycloak.createRealm(project.keycloakRealm);
        const clients = await this.keycloak.createClients(project.keycloakRealm);
        await this.prisma.project.update({
          where: { id: project.id },
          data: { anonKey: clients.anonKey, serviceKey: clients.serviceKey },
        });
        created.push('authentication realm', 'anon and service clients');
        keysRotated = true;
        this.logger.warn(
          `Repaired missing realm "${project.keycloakRealm}" for project ${project.slug}; API keys were reissued`,
        );
      } else {
        alreadyPresent.push('authentication realm');
      }
    }

    if (created.length > 0) {
      await this.activity.append(project.id, {
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Missing infrastructure restored',
        detail: created.join(', ') + (keysRotated ? '; the project API keys were reissued' : ''),
      });
    }

    return { projectId: project.id, created, alreadyPresent, keysRotated };
  }

  /**
   * Idempotent re-application triggered by the admin UI / backfill script.
   * Looks up the project, runs the bootstrap (whose SQL ends in a sentinel
   * SET ROLE round-trip — so silent failure is impossible), stamps
   * `rlsBootstrappedAt`, then runs `diagnoseRls` for an independent post-flight
   * check. The structured return surfaces enough state for callers to decide
   * whether to retry the original request or escalate to a human.
   */
  async ensureRlsBootstrap(
    projectId: string,
  ): Promise<RlsBootstrapResult> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: {
        id: true,
        dbName: true,
        dbHost: true,
        dbPort: true,
        dbUser: true,
        dbPassword: true,
        autoGrantNewTables: true,
        rlsOnNewTables: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const cfgHost = this.config.get<string>('database.host');
    const cfgPort = Number(this.config.get<number>('database.port'));

    if (!(project.dbHost === cfgHost && Number(project.dbPort) === cfgPort)) {
      // Dedicated host — we don't have cached admin creds here.
      // The infra service owns those; for now we just refuse and log.
      throw new InternalServerErrorException(
        'RLS bootstrap for dedicated-host projects must be invoked via the provisioning flow',
      );
    }

    // The SQL itself contains the sentinel; if grants are missing it raises
    // SQLSTATE 42501 with a detailed message. We let that bubble up so callers
    // see the real reason instead of a generic "bootstrap failed".
    await this.applyRlsBootstrap(project.dbName, project.dbUser, dataAccessOf(project));

    // Independent post-flight: connect AS the project owner and try SET ROLE
    // for each of anon/authenticated/service_role. Mirrors what the data API
    // does at request time.
    const diagnose = await this.diagnoseRls(projectId);

    if (diagnose.sentinelPassed) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "projects" SET "rls_bootstrapped_at" = NOW() WHERE "id" = $1`,
        project.id,
      );
    } else {
      // Don't stamp rls_bootstrapped_at when the sentinel says we're broken —
      // that mark is what the backfill script and the data API treat as
      // "this project is healthy", and stamping it on a failed run is exactly
      // how legacy projects ended up wedged.
      this.logger.error(
        `ensureRlsBootstrap: sentinel failed for project ${projectId} after ` +
          `apply succeeded. Roles missing: ${diagnose.failedRoles.join(', ') || 'n/a'}.`,
      );
    }

    return {
      bootstrappedAt: new Date(),
      sentinelPassed: diagnose.sentinelPassed,
      rolesPresent: diagnose.rolesPresent,
      failedRoles: diagnose.failedRoles,
      currentUser: diagnose.currentUser,
    };
  }

  /**
   * Read-only diagnostic. Connects to the project DB twice:
   *   1. As the control-plane admin, to read pg_roles + pg_auth_members.
   *   2. As the project's connecting user (the same one the data API uses),
   *      to try SET ROLE for each of anon/authenticated/service_role.
   * Returned shape is intended to be exposed via GET /projects/:id/rls-diagnose
   * so support can answer "why is this project's data API 500-ing" in one call
   * without shelling into the DB.
   */
  async diagnoseRls(projectId: string): Promise<RlsDiagnostic> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { id: true, dbName: true, dbHost: true, dbPort: true, dbUser: true, dbPassword: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const cfgHost = this.config.get<string>('database.host');
    const cfgPort = Number(this.config.get<number>('database.port'));
    const onSharedHost = project.dbHost === cfgHost && Number(project.dbPort) === cfgPort;

    const sanitizedDb = project.dbName.replace(/[^a-z0-9_]/g, '');
    const sanitizedUser = project.dbUser.replace(/[^a-z0-9_]/g, '');

    // Step 1: admin pool — only available on shared host.
    const targetRoles = ['anon', 'authenticated', 'service_role'] as const;
    const rolesPresent: string[] = [];
    const memberships: Record<string, string[]> = {};
    if (onSharedHost) {
      const adminPool = new Pool({
        host: cfgHost,
        port: cfgPort,
        user: this.config.get('database.user'),
        password: this.config.get('database.password'),
        database: sanitizedDb,
      });
      try {
        const adminClient = await adminPool.connect();
        try {
          const rolesQ = await adminClient.query<{ rolname: string }>(
            `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])`,
            [[...targetRoles, sanitizedUser]],
          );
          for (const row of rolesQ.rows) rolesPresent.push(row.rolname);

          const memQ = await adminClient.query<{ member: string; role: string }>(
            `SELECT m.rolname AS member, r.rolname AS role
             FROM pg_auth_members am
             JOIN pg_roles m ON m.oid = am.member
             JOIN pg_roles r ON r.oid = am.roleid
             WHERE m.rolname = $1 OR r.rolname = ANY($2::text[])`,
            [sanitizedUser, [...targetRoles]],
          );
          for (const row of memQ.rows) {
            (memberships[row.member] ||= []).push(row.role);
          }
        } finally {
          adminClient.release();
        }
      } catch (err: any) {
        this.logger.warn(
          `diagnoseRls: admin probe failed for project ${projectId}: ${err.message}`,
        );
      } finally {
        await adminPool.end();
      }
    }

    // Step 2: connect AS the project owner and try SET ROLE for each target.
    const setRoleResults: Record<string, { ok: boolean; error?: string }> = {};
    let currentUser: string | null = null;
    const failedRoles: string[] = [];
    const projectPool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 5_000,
    });
    try {
      const c = await projectPool.connect();
      try {
        const cu = await c.query<{ current_user: string }>(`SELECT current_user`);
        currentUser = cu.rows[0]?.current_user ?? null;

        for (const role of targetRoles) {
          await c.query('BEGIN');
          try {
            await c.query(`SET LOCAL ROLE "${role}"`);
            await c.query(`SELECT 1`);
            setRoleResults[role] = { ok: true };
          } catch (err: any) {
            setRoleResults[role] = {
              ok: false,
              error: `${err.code ?? '?'}: ${err.message}`,
            };
            failedRoles.push(role);
          } finally {
            try { await c.query('ROLLBACK'); } catch { /* noop */ }
          }
        }
      } finally {
        c.release();
      }
    } catch (err: any) {
      this.logger.warn(
        `diagnoseRls: project-owner probe failed for ${projectId}: ${err.message}`,
      );
      // Mark all roles as failed if we couldn't even connect.
      for (const role of targetRoles) {
        if (!(role in setRoleResults)) {
          setRoleResults[role] = { ok: false, error: `connect failed: ${err.message}` };
          failedRoles.push(role);
        }
      }
    } finally {
      await projectPool.end();
    }

    return {
      projectId,
      onSharedHost,
      currentUser,
      connectingUser: project.dbUser,
      rolesPresent,
      memberships,
      setRoleResults,
      failedRoles,
      sentinelPassed: failedRoles.length === 0,
    };
  }

  private async runRlsBootstrap(pool: Pool, sanitizedUser: string, flags: DataAccessFlags): Promise<void> {
    const template = this.loadRlsBootstrapSql();
    if (!/^[a-z0-9_]+$/.test(sanitizedUser)) {
      throw new BadRequestException('Invalid project owner identifier');
    }
    const sql = renderRlsBootstrap(template, sanitizedUser, flags);

    const client = await pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  /**
   * Allocate stable Postgres identifiers for a new project. They are not derived from the
   * project name/slug so renaming the project has no effect on connection strings. Existing
   * projects (created with slug-based names) are not migrated.
   */
  private async uniqueDatabaseNameAndUser(): Promise<{ dbName: string; dbUser: string }> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const nameToken = randomBytes(8).toString('hex');
      const userToken = randomBytes(8).toString('hex');
      const dbName = `kb_${nameToken}`;
      const dbUser = `kb_user_${userToken}`;
      const clash = await this.prisma.project.findFirst({
        where: { OR: [{ dbName }, { dbUser }] },
        select: { id: true },
      });
      if (!clash) {
        return { dbName, dbUser };
      }
    }
    throw new InternalServerErrorException('Could not allocate unique database name and user');
  }

  private toSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  }

  /**
   * Slugs are globally unique (they seed realm and resource names), so two
   * customers can collide on the same project name. Every slug carries a
   * short random suffix — uniform across all projects, no cross-tenant
   * name leak, no races under concurrent creates. Existing slugs are
   * never rewritten retroactively.
   */
  private async uniqueSlug(base: string): Promise<string> {
    // Keep room for the suffix so realm/db names stay comfortably bounded.
    const trimmedBase = base.slice(0, 48);

    // Every project gets a suffix — uniform identity, zero cross-tenant
    // information leak, and restores/renames can never collide.
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = randomBytes(4).toString('base64url')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase()
        .slice(0, 6)
        .padEnd(6, '0');
      const candidate = `${trimmedBase}_${suffix}`;
      const found = await this.prisma.project.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!found) return candidate;
    }
    // Astronomically unlikely fallback — still random, never sequential.
    return `${trimmedBase}_${randomBytes(8).toString('hex').slice(0, 10)}`;
  }

  private stripDeletedSuffix(value: string): string {
    return value.replace(/_(\d+_)?deleted$/, '');
  }

  /**
   * A project's effective storage prefix (storagePrefix ?? slug) must be unique
   * across active projects — otherwise two projects map to the same MinIO bucket
   * namespace and bucket ownership becomes ambiguous (buckets vanish from one
   * project's list). When a candidate prefix already belongs to another active
   * project, append a short random suffix to keep it unambiguous.
   */
  private async uniqueStoragePrefix(candidate: string, excludeProjectId: string): Promise<string> {
    const clash = await this.prisma.project.findFirst({
      where: {
        status: 'ACTIVE',
        id: { not: excludeProjectId },
        OR: [{ slug: candidate }, { storagePrefix: candidate }],
      },
      select: { id: true },
    });
    if (!clash) return candidate;
    // No hyphen before the suffix: `<candidate>-<hex>` would sit inside the namespace of the
    // project that holds `<candidate>` (bf-x- is a prefix of bf-x-ab12cd-), see bucket-names.ts.
    return `${candidate}${randomBytes(3).toString('hex')}`;
  }

  /**
   * Storage prefix for a new project, or null to use the slug. Physical bucket names are
   * `bf-<prefix>-<bucket>` and the hyphen is ambiguous: when `bf-<slug>-` starts with another
   * project's namespace (any status) or another one starts with it, or it falls in the platform
   * namespace, the project gets a hyphen-free prefix instead (`acmek3j2h1q9w8e7`), so no bucket
   * it ever creates can be read as another project's. Existing projects are never changed.
   */
  private async newProjectStoragePrefix(slug: string): Promise<string | null> {
    const existing = (
      await this.prisma.project.findMany({ select: { slug: true, storagePrefix: true } })
    ).map((p) => p.storagePrefix ?? p.slug);
    if (!prefixIsAmbiguous(slug, existing)) return null;
    const base = slug.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'p';
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = `${base}${randomBytes(6).toString('hex').slice(0, 8)}`;
      if (!prefixIsAmbiguous(candidate, existing)) return candidate;
    }
    throw new InternalServerErrorException('Could not pick a storage namespace for the project; try again');
  }

  private async uniqueDeletedName(baseName: string): Promise<string> {
    const candidate = `${baseName}_deleted`;
    const existing = await this.prisma.project.findFirst({
      where: { name: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;

    for (let i = 2; i <= 100; i++) {
      const numbered = `${baseName}_${i}_deleted`;
      const found = await this.prisma.project.findFirst({
        where: { name: numbered },
        select: { id: true },
      });
      if (!found) return numbered;
    }
    return `${baseName}_${Date.now()}_deleted`;
  }

  private async uniqueDeletedSlug(baseSlug: string): Promise<string> {
    const candidate = `${baseSlug}_deleted`;
    const existing = await this.prisma.project.findFirst({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;

    for (let i = 2; i <= 100; i++) {
      const numbered = `${baseSlug}_${i}_deleted`;
      const found = await this.prisma.project.findFirst({
        where: { slug: numbered },
        select: { id: true },
      });
      if (!found) return numbered;
    }
    return `${baseSlug}_${Date.now()}_deleted`;
  }
}
