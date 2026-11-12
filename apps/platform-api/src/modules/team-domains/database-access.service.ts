import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { TeamsService } from '../teams/teams.service';
import { PgBouncerService } from '../pgbouncer/pgbouncer.service';
import { isHbaSafeName, normalizeCidrList } from '../pgbouncer/pgbouncer-hba';
import { ClientTrustBundle } from '../pgbouncer/pooler-tls';
import { TeamDomainsService } from './team-domains.service';

/** How a client can check the pooler's certificate. */
export type TlsVerification = 'public-ca' | 'self-signed' | 'none';

export interface DatabaseAccessView {
  /** Whether this server enforces access rules ('off' = rules cannot be saved yet). */
  enforcement: 'enforced' | 'off';
  tls: {
    available: boolean;
    verification: TlsVerification;
    subject: string | null;
    validTo: string | null;
  };
  policy: { requireTls: boolean; allowedCidrs: string[]; updatedAt: Date | null };
  canManage: boolean;
  hosts: {
    pooler: { host: string; port: number };
    /** The team's workspace address, when it has one; `live` = it answers on this server. */
    workspace: { host: string; port: number; live: boolean } | null;
  };
}

/**
 * Who may reach a project's database from outside: TLS required, and an
 * address allow list, both enforced by the pooler. Also the certificate file
 * clients use to verify the pooler.
 */
@Injectable()
export class DatabaseAccessService {
  private readonly logger = new Logger(DatabaseAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly teams: TeamsService,
    private readonly pgbouncer: PgBouncerService,
    private readonly domains: TeamDomainsService,
  ) {}

  private async loadProject(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: {
        id: true,
        teamId: true,
        dbName: true,
        dbAccessPolicy: { select: { requireTls: true, allowedCidrs: true, updatedAt: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  private async tlsState(): Promise<{ bundle: ClientTrustBundle | null; view: DatabaseAccessView['tls'] }> {
    const available = this.pgbouncer.isTlsAvailable();
    const bundle = available ? await this.pgbouncer.clientTrustBundle() : null;
    return {
      bundle,
      view: {
        available,
        verification: bundle ? bundle.kind : 'none',
        subject: bundle ? bundle.subjectAltName ?? bundle.subject : null,
        validTo: bundle ? bundle.validTo : null,
      },
    };
  }

  async get(projectId: string, userId: string): Promise<DatabaseAccessView> {
    const project = await this.loadProject(projectId);
    const member = await this.teams.assertMember(project.teamId, userId);
    const [{ view: tls }, workspace] = await Promise.all([
      this.tlsState(),
      this.domains.workspaceForTeam(project.teamId),
    ]);
    const port = this.config.get<number>('pgbouncer.externalPort') || 6432;
    return {
      enforcement: this.pgbouncer.networkRulesEnforced() ? 'enforced' : 'off',
      tls,
      policy: {
        requireTls: project.dbAccessPolicy?.requireTls ?? false,
        allowedCidrs: project.dbAccessPolicy?.allowedCidrs ?? [],
        updatedAt: project.dbAccessPolicy?.updatedAt ?? null,
      },
      canManage: member.role === 'OWNER' || member.role === 'ADMIN',
      hosts: {
        pooler: { host: this.config.get<string>('pgbouncer.externalHost') || 'localhost', port },
        workspace: workspace ? { host: workspace.host, port, live: workspace.live } : null,
      },
    };
  }

  /**
   * Save the rules and rewrite the pooler config. Owners and admins of the
   * project's team. Refused while this server does not enforce rules, so a
   * setting is never shown as protecting a database it does not protect.
   */
  async update(
    projectId: string,
    userId: string,
    input: { requireTls: boolean; allowedCidrs: string[] },
  ): Promise<DatabaseAccessView & { applied: boolean }> {
    const project = await this.loadProject(projectId);
    await this.teams.assertOwnerOrAdmin(project.teamId, userId);

    if (!this.pgbouncer.networkRulesEnforced()) {
      throw new ConflictException({
        code: 'NETWORK_RULES_UNAVAILABLE',
        message: 'Database access rules are not enabled on this server yet.',
      });
    }
    const cidrs = normalizeCidrList(input.allowedCidrs ?? []);
    if (!cidrs.ok) throw new BadRequestException({ code: 'INVALID_ALLOWED_ADDRESS', message: cidrs.message });
    const requireTls = input.requireTls === true;
    if (requireTls && !this.pgbouncer.isTlsAvailable()) {
      throw new ConflictException({
        code: 'TLS_UNAVAILABLE',
        message: 'The database pooler does not offer TLS on this server, so TLS cannot be required.',
      });
    }
    if ((requireTls || cidrs.value.length) && !isHbaSafeName(project.dbName)) {
      throw new ConflictException({
        code: 'NETWORK_RULES_UNSUPPORTED',
        message: 'Access rules are not supported for this database. Contact support.',
      });
    }

    await this.prisma.projectDbAccessPolicy.upsert({
      where: { projectId },
      create: { projectId, requireTls, allowedCidrs: cidrs.value, updatedBy: userId },
      update: { requireTls, allowedCidrs: cidrs.value, updatedBy: userId },
    });
    this.logger.log(
      `Project ${projectId} database access set by ${userId}: TLS ${requireTls ? 'required' : 'optional'}, ` +
        (cidrs.value.length ? `allowed ${cidrs.value.join(', ')}` : 'any address'),
    );

    let applied = true;
    try {
      await this.pgbouncer.regenerateConfig();
    } catch (err: any) {
      applied = false;
      this.logger.error(`Pooler config not rewritten after access rule change for ${projectId}: ${err.message}`);
    }
    return { ...(await this.get(projectId, userId)), applied };
  }

  /**
   * The certificate file for `sslrootcert`. Only offered for a certificate
   * from a public authority: a file pinned to today's self-signed certificate
   * would stop working for every client that saved it the day the server
   * switches to a public one.
   */
  async caCertificate(projectId: string, userId: string): Promise<{ filename: string; pem: string }> {
    const project = await this.loadProject(projectId);
    await this.teams.assertMember(project.teamId, userId);
    const { bundle } = await this.tlsState();
    if (!bundle || bundle.kind !== 'public-ca') {
      throw new NotFoundException({
        code: 'CA_CERTIFICATE_UNAVAILABLE',
        message:
          'This server does not present a certificate from a public authority yet. Connect with sslmode=require; verified connections become available once it does.',
      });
    }
    return { filename: 'basefyio-db-root-ca.pem', pem: bundle.pem };
  }
}
