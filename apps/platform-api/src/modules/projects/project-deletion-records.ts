import { ProjectActivityKind } from './project-activity.service';

/**
 * Project deletion records (#190). Activity log rows cascade away with the
 * project, so a permanently deleted project vanished from the console's
 * deletion list. A `project_deletion_records` row is a snapshot with no
 * relation to `projects` and survives every kind of deletion.
 */

export type DeletionRecordKind = 'trashed' | 'restored' | 'permanent';

/** The name a user knew, without the internal trash suffix ("app_deleted", "app_2_deleted"). */
export function displayProjectName(name: string): string {
  return name.replace(/_(\d+_)?deleted$/, '');
}

/** Shown when the user picked no reason; "none" stays the explicit "None of the above". */
export const NO_REASON_LABEL = 'No reason given';

export interface DeletionReasonInput {
  reasonCode?: string | null;
  reasonLabel?: string | null;
  details?: string | null;
}

/** An empty or missing code means no reason was chosen: stored as null, not as "none". */
export function normalizeDeletionReason(reason?: DeletionReasonInput) {
  const code = reason?.reasonCode?.trim() || null;
  return {
    reasonCode: code ? code.slice(0, 80) : null,
    reasonLabel: code ? (reason?.reasonLabel?.trim() || code).slice(0, 512) : null,
    details: reason?.details?.trim() || null,
  };
}

interface ProjectSnapshot {
  id: string;
  name: string;
  slug?: string | null;
  teamId?: string | null;
  parentProjectId?: string | null;
}

/**
 * Write one record. Never throws: a failed record must not stop a delete,
 * restore or purge (it is logged instead).
 */
export async function recordProjectDeletion(
  prisma: any,
  logger: { warn: (msg: string) => void } | undefined,
  input: {
    kind: DeletionRecordKind;
    project: ProjectSnapshot;
    actorUserId?: string | null;
    reason?: DeletionReasonInput;
  },
): Promise<void> {
  try {
    const { project } = input;
    let teamName: string | null = null;
    if (project.teamId) {
      const team = await prisma.team?.findUnique?.({
        where: { id: project.teamId },
        select: { name: true },
      });
      teamName = team?.name ?? null;
    }
    const reason = normalizeDeletionReason(input.reason);
    await prisma.projectDeletionRecord.create({
      data: {
        kind: input.kind,
        projectId: project.id,
        projectName: displayProjectName(project.name),
        projectSlug: project.slug ? displayProjectName(project.slug) : null,
        parentProjectId: project.parentProjectId ?? null,
        teamId: project.teamId ?? null,
        teamName,
        actorUserId: input.actorUserId ?? null,
        ...reason,
      },
    });
  } catch (err: any) {
    logger?.warn(`Deletion record (${input.kind}) for project ${input.project.id} not written: ${err?.message ?? err}`);
  }
}

export interface DeletionReasonEntry {
  id: string;
  /** trashed | restored | permanent */
  kind: DeletionRecordKind;
  createdAt: Date;
  actorUserId: string | null;
  actorName: string | null;
  projectId: string;
  projectName: string | null;
  isPreviewBranch: boolean;
  teamId: string | null;
  teamName: string | null;
  /** Current status of the project row; null once it is permanently deleted. */
  projectStatus: string | null;
  /** null: no reason was chosen. "none": the user picked "None of the above". */
  reasonCode: string | null;
  reasonLabel: string | null;
  details: string | null;
  /** "record": project_deletion_records; "activity": an older activity row (trash events only). */
  source: 'record' | 'activity';
}

/**
 * The console's deletion list: every record, plus the older activity rows
 * written before records existed (those carry no `deletionRecorded` marker).
 * Older rows are shown as they are; their "none" can mean either "no reason"
 * or "None of the above" and is not rewritten.
 */
export async function listDeletionEntries(prisma: any, limit = 200): Promise<DeletionReasonEntry[]> {
  const take = Math.max(1, Math.min(limit || 200, 500));
  const [records, activityRows] = await Promise.all([
    prisma.projectDeletionRecord.findMany({ orderBy: { createdAt: 'desc' }, take }),
    prisma.projectActivityLog.findMany({
      where: { kind: ProjectActivityKind.PROJECT_DELETED },
      orderBy: { createdAt: 'desc' },
      take,
    }),
  ]);
  // Filtered here, not in SQL: a JSON-path NOT also drops rows that lack the key.
  const legacy = activityRows.filter(
    (x: any) => !(x.metadata && typeof x.metadata === 'object' && (x.metadata as any).deletionRecorded === true),
  );

  const actorIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const r of records) {
    if (r.actorUserId) actorIds.add(r.actorUserId);
    projectIds.add(r.projectId);
  }
  for (const l of legacy) {
    if (l.userId) actorIds.add(l.userId);
    projectIds.add(l.projectId);
  }

  const [actors, projects] = await Promise.all([
    actorIds.size
      ? prisma.user.findMany({
          where: { id: { in: [...actorIds] } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : Promise.resolve([]),
    projectIds.size
      ? prisma.project.findMany({
          where: { id: { in: [...projectIds] } },
          select: { id: true, name: true, status: true, teamId: true, parentProjectId: true, team: { select: { id: true, name: true } } },
        })
      : Promise.resolve([]),
  ]);
  const actorById = new Map<string, any>(actors.map((a: any) => [a.id, a]));
  const projectById = new Map<string, any>(projects.map((p: any) => [p.id, p]));
  const actorName = (id: string | null) => {
    const a = id ? actorById.get(id) : null;
    if (!a) return null;
    return [a.firstName, a.lastName].filter(Boolean).join(' ').trim() || a.email || null;
  };

  const fromRecords: DeletionReasonEntry[] = records.map((r: any) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.createdAt,
    actorUserId: r.actorUserId,
    actorName: actorName(r.actorUserId),
    projectId: r.projectId,
    projectName: r.projectName,
    isPreviewBranch: Boolean(r.parentProjectId),
    teamId: r.teamId,
    teamName: r.teamName ?? projectById.get(r.projectId)?.team?.name ?? null,
    projectStatus: projectById.get(r.projectId)?.status ?? null,
    reasonCode: r.reasonCode,
    reasonLabel: r.reasonLabel,
    details: r.details,
    source: 'record',
  }));

  const fromLegacy: DeletionReasonEntry[] = legacy.map((x: any) => {
    const m = x.metadata && typeof x.metadata === 'object' ? (x.metadata as Record<string, unknown>) : {};
    const p = projectById.get(x.projectId);
    const name = (typeof m.originalProjectName === 'string' && m.originalProjectName) || p?.name || null;
    return {
      id: x.id,
      kind: 'trashed',
      createdAt: x.createdAt,
      actorUserId: x.userId,
      actorName: actorName(x.userId),
      projectId: x.projectId,
      projectName: name ? displayProjectName(name) : null,
      isPreviewBranch: Boolean(p?.parentProjectId),
      teamId: p?.team?.id || p?.teamId || null,
      teamName: p?.team?.name || null,
      projectStatus: p?.status ?? null,
      reasonCode: typeof m.reasonCode === 'string' ? m.reasonCode : null,
      reasonLabel: typeof m.reasonLabel === 'string' ? m.reasonLabel : null,
      details: typeof m.details === 'string' ? m.details : null,
      source: 'activity',
    };
  });

  return [...fromRecords, ...fromLegacy]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, take);
}

/**
 * Projects permanently deleted, as far as records know (from #190 on; older
 * permanent deletions left no trace). Preview branches are left out.
 */
export async function countPermanentlyDeletedProjects(prisma: any): Promise<number> {
  const rows = await prisma.projectDeletionRecord.findMany({
    where: { kind: 'permanent', parentProjectId: null },
    distinct: ['projectId'],
    select: { projectId: true },
  });
  return rows.length;
}

/**
 * The reason from the project's latest "moved to trash" activity row, read
 * before the row cascades away, so the permanent record keeps the reason.
 */
export async function lastTrashReason(prisma: any, projectId: string): Promise<DeletionReasonInput | undefined> {
  try {
    const row = await prisma.projectActivityLog.findFirst({
      where: { projectId, kind: ProjectActivityKind.PROJECT_DELETED },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    const m = row?.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : null;
    if (!m) return undefined;
    return {
      reasonCode: typeof m.reasonCode === 'string' ? m.reasonCode : null,
      reasonLabel: typeof m.reasonLabel === 'string' ? m.reasonLabel : null,
      details: typeof m.details === 'string' ? m.details : null,
    };
  } catch {
    return undefined;
  }
}
