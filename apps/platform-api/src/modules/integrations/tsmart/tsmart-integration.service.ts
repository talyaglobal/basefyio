import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ProjectDatabaseType, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** Upper bound on rows per response; a warning is logged when it is reached. */
export const TSMART_PROJECT_LIMIT = 5000;

/**
 * Exactly the columns the response needs.
 *
 * A Project row also holds the database password, the anon and service keys,
 * GitHub/Vercel tokens and the embedding API key. None of them is selected
 * here, so none can reach tsmart even if the mapping below were changed
 * carelessly.
 */
export const tsmartProjectSelect = {
  id: true,
  name: true,
  status: true,
  databaseType: true,
  createdAt: true,
  deletedAt: true,
  deactivatedAt: true,
  createdBy: true,
  team: {
    select: {
      id: true,
      name: true,
      slug: true,
      // Fallback owner when the creator is unknown: the earliest OWNER.
      members: {
        where: { role: 'OWNER' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { user: { select: { email: true } } },
      },
    },
  },
  usage: {
    select: {
      dbSizeBytes: true,
      storageBytes: true,
      apiRequestsMonth: true,
      bandwidthMonth: true,
      dbSizeCalculatedAt: true,
      storageCalculatedAt: true,
    },
  },
} satisfies Prisma.ProjectSelect;

export type TsmartProjectRow = Prisma.ProjectGetPayload<{ select: typeof tsmartProjectSelect }>;

export interface TsmartProjectUsage {
  db_size_bytes: number;
  storage_bytes: number;
  api_requests_month: number;
  bandwidth_month: number;
  db_size_measured_at: string | null;
  storage_measured_at: string | null;
}

export interface TsmartProject {
  id: string;
  name: string;
  status: ProjectStatus;
  database_type: ProjectDatabaseType;
  created_at: string;
  deleted_at: string | null;
  deactivated_at: string | null;
  team: { id: string; name: string; slug: string };
  owner_email: string | null;
  usage: TsmartProjectUsage;
}

export interface TsmartProjectList {
  object: 'list';
  generated_at: string;
  /** True when the cap cut the list: tsmart must not treat the missing projects as deleted. */
  has_more: boolean;
  data: TsmartProject[];
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Byte counts fit comfortably in a double (exact up to 8 PiB). */
const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));

/**
 * One project as tsmart sees it. Built field by field — never by spreading the
 * row — so the output keys are exactly the documented ones.
 *
 * owner_email: the creator's address, else the team's (earliest) OWNER, else null.
 */
export function toTsmartProject(row: TsmartProjectRow, creatorEmail: string | null): TsmartProject {
  const u = row.usage;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    database_type: row.databaseType,
    created_at: row.createdAt.toISOString(),
    deleted_at: iso(row.deletedAt),
    deactivated_at: iso(row.deactivatedAt),
    team: { id: row.team.id, name: row.team.name, slug: row.team.slug },
    owner_email: creatorEmail ?? row.team.members[0]?.user?.email ?? null,
    usage: {
      db_size_bytes: num(u?.dbSizeBytes),
      storage_bytes: num(u?.storageBytes),
      api_requests_month: num(u?.apiRequestsMonth),
      bandwidth_month: num(u?.bandwidthMonth),
      db_size_measured_at: iso(u?.dbSizeCalculatedAt),
      storage_measured_at: iso(u?.storageCalculatedAt),
    },
  };
}

@Injectable()
export class TsmartIntegrationService {
  private readonly logger = new Logger(TsmartIntegrationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every project row still in the database — including DELETED and
   * DEACTIVATED ones that have not been purged yet — oldest first.
   */
  async listProjects(now: Date = new Date()): Promise<TsmartProjectList> {
    const rows = await this.prisma.project.findMany({
      select: tsmartProjectSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      // One extra row tells us whether the cap cut anything off.
      take: TSMART_PROJECT_LIMIT + 1,
    });

    const hasMore = rows.length > TSMART_PROJECT_LIMIT;
    if (hasMore) {
      this.logger.warn(
        `tsmart project list reached its cap of ${TSMART_PROJECT_LIMIT} rows; newer projects are left out`,
      );
      rows.length = TSMART_PROJECT_LIMIT;
    }

    // Project.createdBy is a bare user id (no relation), so resolve it in one query.
    const creatorIds = [
      ...new Set(rows.map((r) => r.createdBy).filter((id): id is string => !!id)),
    ];
    const creators = creatorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, email: true },
        })
      : [];
    const emailById = new Map(creators.map((u) => [u.id, u.email]));

    return {
      object: 'list',
      generated_at: now.toISOString(),
      has_more: hasMore,
      data: rows.map((r) =>
        toTsmartProject(r, (r.createdBy && emailById.get(r.createdBy)) || null),
      ),
    };
  }
}
