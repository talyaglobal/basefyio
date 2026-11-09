import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';

export interface AuthUserRow {
  projectId: string;
  projectName: string;
  teamName: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface AuthUsersExport {
  rows: AuthUserRow[];
  errors: { projectId: string; projectName: string; error: string }[];
}

const COLUMNS: (keyof AuthUserRow)[] = [
  'projectId', 'projectName', 'teamName', 'email', 'firstName', 'lastName', 'emailVerified', 'enabled', 'createdAt',
];

/** One quoted CSV cell. A cell a spreadsheet would read as a formula gets a leading single quote. */
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: AuthUserRow[]): string {
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/** Anonymous sign-ins carry no address or a placeholder under the reserved `.invalid` domain. */
export function hasRealEmail(u: { email?: string | null; isAnonymous?: boolean }): boolean {
  const e = (u.email ?? '').trim().toLowerCase();
  return !u.isAnonymous && /^[^@\s]+@[^@\s]+$/.test(e) && !e.endsWith('.invalid');
}

@Injectable()
export class AuthUsersExportService {
  private readonly logger = new Logger(AuthUsersExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
  ) {}

  /** Every project that is not DELETED (deactivated ones keep their data), realm by realm. */
  async collect(projectId?: string): Promise<AuthUsersExport> {
    const projects = await this.prisma.project.findMany({
      where: { status: { not: 'DELETED' }, keycloakRealm: { not: '' }, ...(projectId ? { id: projectId } : {}) },
      select: { id: true, name: true, keycloakRealm: true, team: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const out: AuthUsersExport = { rows: [], errors: [] };
    for (const p of projects) {
      try {
        for (const u of await this.keycloak.listAllUsers(p.keycloakRealm)) {
          if (!hasRealEmail(u)) continue;
          out.rows.push({
            projectId: p.id,
            projectName: p.name,
            teamName: p.team?.name ?? '',
            email: u.email!.trim(),
            firstName: u.firstName ?? '',
            lastName: u.lastName ?? '',
            emailVerified: !!u.emailVerified,
            enabled: !!u.enabled,
            createdAt: u.createdTimestamp ? new Date(u.createdTimestamp).toISOString() : '',
          });
        }
      } catch (err: any) {
        out.errors.push({ projectId: p.id, projectName: p.name, error: String(err?.message ?? err) });
      }
    }
    return out;
  }

  /** The audit record: who exported, how many rows. */
  audit(actorId: string, format: string, result: AuthUsersExport) {
    this.logger.log(`Auth users exported by ${actorId} (${format}): ${result.rows.length} rows, ${result.errors.length} project errors`);
  }
}
