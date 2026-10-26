import type { MinuteVerdict } from './slo';

/** How many consecutive down minutes open an incident, and how many clean ones close it. */
export const OPEN_AFTER_DOWN_MINUTES = 3;
export const RESOLVE_AFTER_CLEAN_MINUTES = 5;
/** A verdict older than this no longer says anything about "now". */
const FRESH_MS = 2 * 60_000;

function recent(verdicts: MinuteVerdict[], now: Date, count: number): MinuteVerdict[] | null {
  if (verdicts.length < count) return null;
  const tail = verdicts.slice(-count);
  const newest = tail[tail.length - 1].minute;
  if (now.getTime() - newest > FRESH_MS + 60_000) return null;
  // Consecutive minutes, no gap: a gap means the prober itself paused.
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].minute - tail[i - 1].minute !== 60_000) return null;
  }
  return tail;
}

/** True when the last three observed minutes were all down and the newest is fresh. */
export function shouldOpen(verdicts: MinuteVerdict[], now: Date): boolean {
  const tail = recent(verdicts, now, OPEN_AFTER_DOWN_MINUTES);
  return !!tail && tail.every((v) => v.down);
}

/** True when the last five observed minutes were all up and the newest is fresh. */
export function shouldResolve(verdicts: MinuteVerdict[], now: Date): boolean {
  const tail = recent(verdicts, now, RESOLVE_AFTER_CLEAN_MINUTES);
  return !!tail && tail.every((v) => !v.down);
}
