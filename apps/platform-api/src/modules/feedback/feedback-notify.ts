import { FeedbackStatus } from '@prisma/client';

export const AUTO_CLOSE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export interface FeedbackChange {
  actorName: string;
  comments?: string[];
  status?: { from: string; to: string };
  edited?: boolean;
  /** Pre-written line(s), used by the automatic close. */
  note?: string;
}

/** Only a person other than the reporter triggers a notice (self-actions never do). */
export const shouldNotifyReporter = (reporterId: string, actorUserId?: string | null) =>
  !!actorUserId && actorUserId !== reporterId;

/** Folds a second change on the same item into the pending one: one mail, one push. */
export function mergeChange(a: FeedbackChange | undefined, b: FeedbackChange): FeedbackChange {
  if (!a) return b;
  return {
    actorName: b.actorName,
    comments: [...(a.comments ?? []), ...(b.comments ?? [])],
    // keep the first "from" and the latest "to" so DONE -> OPEN -> DONE reads as no move at all
    status: a.status || b.status ? { from: (a.status ?? b.status)!.from, to: (b.status ?? a.status)!.to } : undefined,
    edited: a.edited || b.edited,
    note: b.note ?? a.note,
  };
}

const label = (s: string) => s.replace('_', ' ').toLowerCase();

export function describeChange(c: FeedbackChange): string[] {
  const lines: string[] = [];
  if (c.note) lines.push(c.note);
  if (c.comments?.length) lines.push(`${c.actorName} commented.`);
  if (c.status && c.status.from !== c.status.to) lines.push(`Status changed from ${label(c.status.from)} to ${label(c.status.to)}.`);
  if (c.edited) lines.push(`${c.actorName} edited the title or description.`);
  return lines;
}

/**
 * DONE items to close: past 3 days since done_at are closed with a notice; a NULL done_at
 * is a legacy item (DONE before the clock existed) and is closed silently.
 */
export function pickAutoClose(
  items: { id: string; status: FeedbackStatus; doneAt: Date | null }[],
  now: Date,
): { notify: string[]; silent: string[] } {
  const out = { notify: [] as string[], silent: [] as string[] };
  for (const i of items) {
    if (i.status !== FeedbackStatus.DONE) continue;
    if (!i.doneAt) out.silent.push(i.id);
    else if (now.getTime() - i.doneAt.getTime() >= AUTO_CLOSE_AFTER_MS) out.notify.push(i.id);
  }
  return out;
}
