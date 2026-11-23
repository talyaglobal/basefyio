import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TeamMemberRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { roleAllows } from '../teams/role-permissions';
import { ProjectActivityKind } from './project-activity.service';
import { buildConnectionDetails } from './project-secrets';

/** Columns the connection details are built from, credentials included. Never returned as is. */
const CONNECTION_SELECT = {
  id: true,
  teamId: true,
  dbHost: true,
  dbPort: true,
  dbName: true,
  dbUser: true,
  dbPassword: true,
  keycloakRealm: true,
  anonKey: true,
  serviceKey: true,
  serviceKeyLastUsedAt: true,
  dbReadonlyUser: true,
  dbReadonlyPassword: true,
  maxDbConnections: true,
  extraRoles: {
    select: { id: true, label: true, roleName: true, password: true, memberOf: true, createdAt: true },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

export type ConnectionDetails = ReturnType<typeof buildConnectionDetails>;

/**
 * The project's credentials on demand (#14).
 *
 * Who may reveal: the team's owners and admins, and any role holding the credentials permission
 * (`canResetDbPassword`, the one that already gates rotating them). Members without it see the
 * masked details only. Each reveal writes a `project.secrets_revealed` activity entry naming
 * the person; the route is session-only and answers `Cache-Control: no-store`.
 *
 * The service key follows the API keys card: it is returned only while no application has used
 * it. After first use it stays hidden; rotate it or create a secret key instead.
 */
@Injectable()
export class ProjectSecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** The project row with its credentials, for building connection details on the server. */
  async loadConnectionRow(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: CONNECTION_SELECT,
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  /** May this role see the project's credentials in clear? */
  async roleMayReveal(teamId: string, role: TeamMemberRole): Promise<boolean> {
    if (role === 'OWNER' || role === 'ADMIN') return true;
    return roleAllows(this.prisma, teamId, role, 'canResetDbPassword');
  }

  /** The caller's role in the project's team, or null when they are not a member. */
  async memberRole(teamId: string, userId: string | undefined): Promise<TeamMemberRole | null> {
    if (!userId) return null;
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  async canReveal(teamId: string, userId: string | undefined): Promise<boolean> {
    const role = await this.memberRole(teamId, userId);
    return role ? this.roleMayReveal(teamId, role) : false;
  }

  /** The masked details: the same shape with every password and the service key left out. */
  masked(project: Awaited<ReturnType<ProjectSecretsService['loadConnectionRow']>>): ConnectionDetails {
    return buildConnectionDetails(project, this.config);
  }

  async reveal(projectId: string, userId: string) {
    const project = await this.loadConnectionRow(projectId);
    const role = await this.memberRole(project.teamId, userId);
    if (!role) throw new ForbiddenException('Not a member of this team');
    if (!(await this.roleMayReveal(project.teamId, role))) {
      throw new ForbiddenException(
        'Your role cannot see this project\'s credentials. Ask a team owner or admin, or for the "reset database password" permission.',
      );
    }

    const serviceKeyRevealable = project.serviceKeyLastUsedAt == null;
    const details = buildConnectionDetails(
      { ...project, serviceKey: serviceKeyRevealable ? project.serviceKey : null },
      this.config,
      { reveal: true },
    );

    const fields = ['dbPassword'];
    if (details.readonly?.password) fields.push('dbReadonlyPassword');
    if (details.extraRoles.length > 0) fields.push('extraRolePasswords');
    if (details.serviceKey) fields.push('serviceKey');
    // Written before the values leave, and not through the best-effort activity append: when
    // the entry cannot be recorded the reveal fails.
    await this.prisma.projectActivityLog.create({
      data: {
        projectId,
        userId,
        kind: ProjectActivityKind.PROJECT_SECRETS_REVEALED,
        title: 'Connection credentials revealed',
        detail: `Revealed: ${fields.join(', ')}`,
        metadata: { fields, role },
      },
    });

    return {
      password: details.password,
      uri: details.uri,
      poolerUri: details.poolerUri,
      serviceKey: details.serviceKey,
      /** False once an application has used the service key: rotate it or create a secret key. */
      serviceKeyRevealable,
      readonly: details.readonly,
      extraRoles: details.extraRoles.map(({ id, user, password, uri, poolerUri }) => ({ id, user, password, uri, poolerUri })),
    };
  }
}
