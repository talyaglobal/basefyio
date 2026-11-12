import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';

/** `ProjectActivityKind.PROJECT_DELETED`, kept literal so this module stays light to import. */
const PROJECT_DELETED = 'project.deleted';

export type DeletionKind = 'trashed' | 'permanent' | 'purged';

export interface DeletionReason {
  reasonCode: string | null;
  reasonLabel: string | null;
  details: string | null;
}

/** A trashed project's name carries an internal `_deleted` suffix; this is the name its owner gave it. */
export function originalProjectName(name: string): string {
  return name.replace(/(_\d+)?_deleted$/, '');
}

/**
 * Write one durable deletion record. It is not linked to the project row, so
 * it survives a permanent deletion (the activity log cascades with the
 * project, which is why permanently deleted projects vanished from the
 * Deletion Reasons list). Never fails the deletion it describes.
 */
export async function recordProjectDeletion(
  prisma: PrismaService,
  logger: Pick<Logger, 'warn'>,
  project: { id: string; name: string; teamId?: string | null; parentProjectId?: string | null },
  kind: DeletionKind,
  userId: string | null,
  reason?: DeletionReason | null,
): Promise<void> {
  try {
    const team = project.teamId
      ? await prisma.team.findUnique({ where: { id: project.teamId }, select: { name: true } })
      : null;
    await prisma.projectDeletionRecord.create({
      data: {
        projectId: project.id,
        projectName: originalProjectName(project.name),
        teamId: project.teamId ?? null,
        teamName: team?.name ?? null,
        userId,
        kind,
        isBranch: !!project.parentProjectId,
        reasonCode: reason?.reasonCode ?? null,
        reasonLabel: reason?.reasonLabel ?? null,
        details: reason?.details ?? null,
      },
    });
  } catch (err: any) {
    logger.warn(`Deletion record for "${project.name}" (${kind}) not written: ${err?.message}`);
  }
}

/** The reason given when a project went to the trash, from the record or the legacy activity row. */
export async function latestTrashReason(prisma: PrismaService, projectId: string): Promise<DeletionReason | null> {
  try {
    const rec = await prisma.projectDeletionRecord.findFirst({
      where: { projectId, kind: 'trashed' },
      orderBy: { createdAt: 'desc' },
      select: { reasonCode: true, reasonLabel: true, details: true },
    });
    if (rec) return rec;
    const act = await prisma.projectActivityLog.findFirst({
      where: { projectId, kind: PROJECT_DELETED },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    if (!act) return null;
    const m = (act.metadata && typeof act.metadata === 'object' ? act.metadata : {}) as Record<string, unknown>;
    return {
      reasonCode: typeof m.reasonCode === 'string' ? m.reasonCode : null,
      reasonLabel: typeof m.reasonLabel === 'string' ? m.reasonLabel : null,
      details: typeof m.details === 'string' ? m.details : null,
    };
  } catch {
    return null;
  }
}

/**
 * Every project deletion step, newest first: moved to trash, deleted
 * permanently by a user, or purged when a retention window ran out.
 *
 * Durable records are the source; trash events from before they existed are
 * still read from the activity log (only while the project row survives —
 * that history was already lost for projects deleted permanently before).
 * A skipped reason question comes back as null, never as "None of the above".
 */
export async function listProjectDeletionReasons(prisma: PrismaService, limit = 200) {
  const take = Math.max(1, Math.min(limit || 200, 500));
  const [records, legacy] = await Promise.all([
    prisma.projectDeletionRecord.findMany({ orderBy: { createdAt: 'desc' }, take }),
    prisma.projectActivityLog.findMany({
      where: { kind: PROJECT_DELETED },
      orderBy: { createdAt: 'desc' },
      take,
    }),
  ]);

  // A trash event written since the records table exists has both rows; keep the record.
  const recordedTrash = records.filter((r) => r.kind === 'trashed');
  const mirrored = (projectId: string, at: Date) =>
    recordedTrash.some(
      (r) => r.projectId === projectId && Math.abs(r.createdAt.getTime() - at.getTime()) < 2 * 60 * 1000,
    );
  const legacyRows = legacy.filter((x) => !mirrored(x.projectId, x.createdAt));

  const actorIds = Array.from(
    new Set(
      [...records.map((x) => x.userId), ...legacyRows.map((x) => x.userId)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );
  const projectIds = Array.from(new Set(legacyRows.map((x) => x.projectId)));

  const [actors, projects] = await Promise.all([
    actorIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : Promise.resolve([]),
    projectIds.length > 0
      ? prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: {
            id: true,
            name: true,
            teamId: true,
            parentProjectId: true,
            team: { select: { id: true, name: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const actorById = new Map(actors.map((a) => [a.id, a] as const));
  const projectById = new Map(projects.map((p) => [p.id, p] as const));
  const actorName = (id: string | null) => {
    if (!id) return null;
    const u = actorById.get(id);
    if (!u) return null;
    return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || null;
  };
  const notSpecified = (code: string | null) => !code || code === 'not_specified';

  const fromRecords = records.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    kind: r.kind,
    isBranch: r.isBranch,
    actorUserId: r.userId,
    actorName: actorName(r.userId),
    projectId: r.projectId,
    projectName: r.projectName,
    teamId: r.teamId,
    teamName: r.teamName,
    reasonCode: notSpecified(r.reasonCode) ? null : r.reasonCode,
    reasonLabel: notSpecified(r.reasonCode) ? null : r.reasonLabel,
    details: r.details,
  }));

  const fromLegacy = legacyRows.map((x) => {
    const metadata = x.metadata && typeof x.metadata === 'object' ? (x.metadata as Record<string, unknown>) : {};
    const project = projectById.get(x.projectId);
    const code = typeof metadata.reasonCode === 'string' ? metadata.reasonCode : null;
    return {
      id: x.id,
      createdAt: x.createdAt,
      kind: 'trashed',
      isBranch: !!project?.parentProjectId,
      actorUserId: x.userId,
      actorName: actorName(x.userId),
      projectId: x.projectId,
      projectName:
        (typeof metadata.originalProjectName === 'string' && metadata.originalProjectName) ||
        (project?.name ? originalProjectName(project.name) : null),
      teamId: project?.team?.id || project?.teamId || null,
      teamName: project?.team?.name || null,
      reasonCode: notSpecified(code) ? null : code,
      reasonLabel: notSpecified(code)
        ? null
        : typeof metadata.reasonLabel === 'string'
          ? metadata.reasonLabel
          : null,
      details: typeof metadata.details === 'string' ? metadata.details : null,
    };
  });

  return [...fromRecords, ...fromLegacy]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, take);
}
