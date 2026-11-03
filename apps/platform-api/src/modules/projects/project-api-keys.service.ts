import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { roleAllows } from '../teams/role-permissions';
import { generateAnonKey, generateSecretKey, generateServiceKey, hashSecretKey, keyHint, maskKey } from '../../common/utils/secret-keys';

/** At most this many active secret keys per project. */
const MAX_ACTIVE_SECRET_KEYS = 20;

export interface ApiKeysView {
  anonKey: string;
  serviceKey: {
    /** Always shown: enough to recognise the key. */
    masked: string;
    /** The full key may still be revealed: no application has used it yet. */
    revealable: boolean;
    lastUsedAt: string | null;
  };
  secretKeys: Array<{
    id: string;
    name: string;
    hint: string;
    createdAt: string;
    lastUsedAt: string | null;
  }>;
  /** The caller may rotate the service key and create or revoke secret keys. */
  canManage: boolean;
}

/**
 * The project's API keys as the dashboard manages them.
 *
 * - The anon key is public and always shown.
 * - The service_role key (`bf_service_…`) is shown masked. It can be revealed and copied until
 *   an application first uses it; after that the dashboard keeps it hidden, and a team member
 *   who needs a server key rotates it or creates a secret key instead.
 * - Secret keys (`bf_secret_…`) carry the same rights as the service key, can be several at
 *   once and are stored only as a hash: the full value is returned once, at creation.
 *
 * Reading the list needs team membership (as reading the project does); rotating, creating and
 * revoking need the team's credential permission (`canResetDbPassword`).
 */
@Injectable()
export class ProjectApiKeysService {
  private readonly logger = new Logger(ProjectApiKeysService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(projectId: string, userId: string): Promise<ApiKeysView> {
    const { project, role } = await this.access(projectId, userId);
    const keys = await this.prisma.projectSecretKey.findMany({
      where: { projectId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, prefix: true, last4: true, createdAt: true, lastUsedAt: true },
    });
    return {
      anonKey: project.anonKey,
      serviceKey: {
        masked: maskKey(project.serviceKey),
        revealable: project.serviceKeyLastUsedAt == null,
        lastUsedAt: project.serviceKeyLastUsedAt?.toISOString() ?? null,
      },
      secretKeys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        hint: `${k.prefix}…${k.last4}`,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      })),
      canManage: await roleAllows(this.prisma, project.teamId, role, 'canResetDbPassword'),
    };
  }

  /** The full service key, only while no application has used it. */
  async revealServiceKey(projectId: string, userId: string): Promise<{ serviceKey: string }> {
    const { project } = await this.access(projectId, userId);
    if (project.serviceKeyLastUsedAt != null) {
      throw new ConflictException(
        'This service key is in use, so it is no longer shown. Rotate it, or create a secret key for the new server.',
      );
    }
    return { serviceKey: project.serviceKey };
  }

  /**
   * A new service key; the old one stops working on the next request. Returned once. Secret keys
   * are untouched, so a server already moved to one keeps running.
   */
  async rotateServiceKey(projectId: string, userId: string): Promise<{ serviceKey: string }> {
    await this.access(projectId, userId, true);
    const serviceKey = generateServiceKey();
    await this.prisma.project.update({
      where: { id: projectId },
      data: { serviceKey, serviceKeyLastUsedAt: null },
    });
    this.logger.log(`Service key rotated for project ${projectId} by ${userId}`);
    return { serviceKey };
  }

  /**
   * A new anon key; the old one is refused from the next request. Every app and page that
   * ships the anon key must be given the new one. Server keys are untouched.
   */
  async rotateAnonKey(projectId: string, userId: string): Promise<{ anonKey: string }> {
    await this.access(projectId, userId, true);
    const anonKey = generateAnonKey();
    await this.prisma.project.update({ where: { id: projectId }, data: { anonKey } });
    this.logger.log(`Anon key rotated for project ${projectId} by ${userId}`);
    return { anonKey };
  }

  async createSecretKey(projectId: string, userId: string, name: unknown): Promise<{ id: string; name: string; key: string; hint: string }> {
    await this.access(projectId, userId, true);
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 60) throw new BadRequestException('Give the key a name of 1–60 characters');
    const active = await this.prisma.projectSecretKey.count({ where: { projectId, revokedAt: null } });
    if (active >= MAX_ACTIVE_SECRET_KEYS) {
      throw new BadRequestException(`A project can have at most ${MAX_ACTIVE_SECRET_KEYS} secret keys; revoke one first`);
    }
    const key = generateSecretKey();
    const { prefix, last4 } = keyHint(key);
    const row = await this.prisma.projectSecretKey.create({
      data: { projectId, name: label, keyHash: hashSecretKey(key), prefix, last4, createdBy: userId },
      select: { id: true, name: true },
    });
    this.logger.log(`Secret key "${label}" created for project ${projectId} by ${userId}`);
    return { id: row.id, name: row.name, key, hint: `${prefix}…${last4}` };
  }

  /** Revoked keys are refused from the next request on. */
  async revokeSecretKey(projectId: string, userId: string, keyId: string): Promise<{ revoked: true }> {
    await this.access(projectId, userId, true);
    const { count } = await this.prisma.projectSecretKey.updateMany({
      where: { id: keyId, projectId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!count) throw new NotFoundException('Secret key not found');
    this.logger.log(`Secret key ${keyId} revoked for project ${projectId} by ${userId}`);
    return { revoked: true };
  }

  private async access(projectId: string, userId: string, manage = false) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { id: true, teamId: true, anonKey: true, serviceKey: true, serviceKeyLastUsedAt: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const member = project.teamId
      ? await this.prisma.teamMember.findUnique({ where: { teamId_userId: { teamId: project.teamId, userId } } })
      : null;
    if (!member) throw new ForbiddenException('Not a member of this project\'s team');
    if (manage && !(await roleAllows(this.prisma, project.teamId, member.role, 'canResetDbPassword'))) {
      throw new ForbiddenException('Your role cannot manage this project\'s keys (it needs the credentials permission)');
    }
    return { project, role: member.role };
  }
}
