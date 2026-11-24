'use client';

/**
 * Guided-tour preferences of the signed-in user. The server is the source of truth
 * (`GET /api/auth/profile` -> `tours`, `PATCH /api/auth/profile/tours`).
 *
 * Rules: optimistic; never throws, never toasts, never touches tokens (a 401 is handled by
 * request()); fails closed (`loaded` stays false while the profile or its `tours` field is
 * missing). Seen ids that could not be saved wait in a per-user localStorage outbox and are
 * retried (marks only add, so a replay is safe). A queued `autoEnabled` expires after 10 minutes,
 * so a stale opt-out cannot undo a newer choice made on another device. A profile response whose
 * request started before a reset is ignored.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { api } from '@/lib/api';
import type { TourPreferences } from '@/lib/types';
import { MAX_IDS_PER_REQUEST, MAX_TOUR_ID_LENGTH, TOUR_ID_PATTERN } from '@/lib/tours/types';

export interface TourPrefs {
  /** The guided_tours flag is on for this user. */
  available: boolean;
  /** available, and the profile arrived with `tours`. Nothing starts automatically before this. */
  loaded: boolean;
  autoEnabled: boolean;
  seen: string[];
  /** Optimistic, silent, never throws. */
  markSeen: (id: string) => void;
  /** Optimistic. Resolves true once the server confirmed, false when kept locally for a retry. Never rejects. */
  setAutoEnabled: (on: boolean) => Promise<boolean>;
  /** Clears the seen list and turns automatic tours on. Resolves false when nothing changed. Never rejects. */
  resetSeen: () => Promise<boolean>;
}

const NOOP_PREFS: TourPrefs = {
  available: false,
  loaded: false,
  autoEnabled: false,
  seen: [],
  markSeen: () => {},
  setAutoEnabled: async () => false,
  resetSeen: async () => false,
};

const TourPrefsContext = createContext<TourPrefs>(NOOP_PREFS);

export function useTourPrefs(): TourPrefs {
  return useContext(TourPrefsContext);
}

const OUTBOX_PREFIX = 'basefyio_tour_outbox_';
const AUTO_TTL_MS = 10 * 60 * 1000;
const RETRY_MS = 30_000;
const MAX_TIMER_RETRIES = 3;

interface Outbox {
  seen: string[];
  autoEnabled?: boolean;
  /** When the queued autoEnabled was chosen. */
  autoAt?: number;
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_TOUR_ID_LENGTH && TOUR_ID_PATTERN.test(id);
}

function asPrefs(v: unknown): TourPreferences | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { autoEnabled?: unknown; seen?: unknown };
  if (typeof o.autoEnabled !== 'boolean' || !Array.isArray(o.seen)) return null;
  return { autoEnabled: o.autoEnabled, seen: o.seen.filter((s): s is string => typeof s === 'string') };
}

function freshAuto(box: Outbox): boolean | undefined {
  if (typeof box.autoEnabled !== 'boolean') return undefined;
  if (!box.autoAt || Date.now() - box.autoAt > AUTO_TTL_MS) return undefined;
  return box.autoEnabled;
}

function readOutbox(userId: string): Outbox {
  try {
    const raw = window.localStorage.getItem(OUTBOX_PREFIX + userId);
    if (!raw) return { seen: [] };
    const v = JSON.parse(raw) as Partial<Outbox>;
    const box: Outbox = { seen: Array.isArray(v.seen) ? v.seen.filter(validId) : [] };
    if (typeof v.autoEnabled === 'boolean' && typeof v.autoAt === 'number') {
      box.autoEnabled = v.autoEnabled;
      box.autoAt = v.autoAt;
      if (freshAuto(box) === undefined) {
        delete box.autoEnabled;
        delete box.autoAt;
      }
    }
    return box;
  } catch {
    return { seen: [] };
  }
}

function writeOutbox(userId: string, box: Outbox) {
  try {
    const empty = box.seen.length === 0 && typeof box.autoEnabled !== 'boolean';
    if (empty) window.localStorage.removeItem(OUTBOX_PREFIX + userId);
    else window.localStorage.setItem(OUTBOX_PREFIX + userId, JSON.stringify(box));
  } catch {
    // storage unavailable: the in-memory session state still holds the change
  }
}

function errorStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

export function TourPrefsProvider({
  userId,
  serverPrefs,
  serverPrefsStartedAt,
  available,
  children,
}: {
  userId: string | null;
  /** `profile.tours`, or null while the profile is missing. */
  serverPrefs: TourPreferences | null | undefined;
  /** When the GET that produced `serverPrefs` was sent (Date.now()); 0 if unknown. */
  serverPrefsStartedAt: number;
  /** featuresLoaded && features.guided_tours */
  available: boolean;
  children: React.ReactNode;
}) {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const serverRef = useRef<TourPreferences | null>(null);
  const outboxRef = useRef<Outbox>({ seen: [] });
  const sessionSeenRef = useRef<Set<string>>(new Set());
  const sessionAutoRef = useRef<boolean | null>(null);
  const resetAtRef = useRef(0);
  const flushingRef = useRef<Promise<void> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRetriesRef = useRef(0);
  const userRef = useRef<string | null>(null);
  const liveRef = useRef({ available, loaded: false });

  // A different user (or the first one): start from that user's outbox, drop session state.
  // Runs before `loaded` is computed, so a render never reports the previous user's server state.
  if (userRef.current !== userId) {
    userRef.current = userId;
    serverRef.current = null;
    sessionSeenRef.current = new Set();
    sessionAutoRef.current = null;
    resetAtRef.current = 0;
    timerRetriesRef.current = 0;
    outboxRef.current = userId && typeof window !== 'undefined' ? readOutbox(userId) : { seen: [] };
  }

  const loaded = available && !!userId && serverRef.current !== null;
  liveRef.current = { available, loaded };

  // Adopt the server value from the profile, unless its request started before the last reset.
  useEffect(() => {
    const next = asPrefs(serverPrefs);
    if (!next) return;
    if (resetAtRef.current && serverPrefsStartedAt < resetAtRef.current) return;
    const prev = serverRef.current;
    const same =
      prev &&
      prev.autoEnabled === next.autoEnabled &&
      prev.seen.length === next.seen.length &&
      prev.seen.every((s, i) => s === next.seen[i]);
    if (same) return;
    serverRef.current = next;
    bump();
  }, [serverPrefs, serverPrefsStartedAt]);

  const persist = useCallback(() => {
    if (userRef.current) writeOutbox(userRef.current, outboxRef.current);
  }, []);

  const flush = useCallback((): Promise<void> => {
    if (flushingRef.current) return flushingRef.current;
    const run = async () => {
      for (;;) {
        const { available: on, loaded: ready } = liveRef.current;
        if (!on || !ready || !userRef.current) return;
        const box = outboxRef.current;
        box.seen = box.seen.filter(validId);
        const sendSeen = box.seen.slice(0, MAX_IDS_PER_REQUEST);
        const sendAuto = freshAuto(box);
        const sendAutoAt = box.autoAt;
        if (sendAuto === undefined && (box.autoEnabled !== undefined || box.autoAt !== undefined)) {
          delete box.autoEnabled;
          delete box.autoAt;
          persist();
        }
        if (sendSeen.length === 0 && sendAuto === undefined) return;
        const body: { markSeen?: string[]; autoEnabled?: boolean } = {};
        if (sendSeen.length) body.markSeen = sendSeen;
        if (sendAuto !== undefined) body.autoEnabled = sendAuto;
        const userAtSend = userRef.current;
        let drop = false;
        try {
          const res = await api.auth.updateTourPrefs(body);
          if (userRef.current !== userAtSend) return;
          const prefs = asPrefs(res);
          if (prefs) serverRef.current = prefs;
          timerRetriesRef.current = 0;
          drop = true;
        } catch (err) {
          if (userRef.current !== userAtSend) return;
          const status = errorStatus(err);
          if (status === 400 || status === 403 || status === 404) {
            drop = true; // never valid: do not retry
          } else {
            if (typeof window !== 'undefined' && !retryTimerRef.current && timerRetriesRef.current < MAX_TIMER_RETRIES) {
              timerRetriesRef.current += 1;
              retryTimerRef.current = setTimeout(() => {
                retryTimerRef.current = null;
                void flush();
              }, RETRY_MS);
            }
            return;
          }
        } finally {
          if (drop) {
            const cur = outboxRef.current;
            cur.seen = cur.seen.filter((id) => !sendSeen.includes(id));
            // Remove the queued choice only if it is still the one that was sent.
            if (sendAuto !== undefined && cur.autoEnabled === sendAuto && cur.autoAt === sendAutoAt) {
              delete cur.autoEnabled;
              delete cur.autoAt;
            }
            persist();
            bump();
          }
        }
      }
    };
    const p = run()
      .catch(() => {})
      .finally(() => {
        flushingRef.current = null;
      });
    flushingRef.current = p;
    return p;
  }, [persist]);

  // Retry what is queued once the server is known (also covers the next mount) and when the browser is back online.
  useEffect(() => {
    if (!loaded) return;
    void flush();
    const onOnline = () => void flush();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [loaded, userId, flush]);

  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    },
    [],
  );

  const markSeen = useCallback(
    (id: string) => {
      try {
        if (!liveRef.current.available || !userRef.current || !validId(id)) return;
        sessionSeenRef.current.add(id);
        if (serverRef.current?.seen.includes(id)) {
          bump(); // already saved on the server
          return;
        }
        if (!outboxRef.current.seen.includes(id)) outboxRef.current.seen.push(id);
        persist();
        bump();
        void flush();
      } catch {
        // never throw
      }
    },
    [flush, persist],
  );

  const setAutoEnabled = useCallback(
    async (on: boolean): Promise<boolean> => {
      try {
        if (!liveRef.current.available || !userRef.current) return false;
        sessionAutoRef.current = on;
        const at = Date.now();
        outboxRef.current.autoEnabled = on;
        outboxRef.current.autoAt = at;
        persist();
        bump();
        await flush();
        // If a flush was already running it may have sent an older value; send ours now.
        if (outboxRef.current.autoAt === at) await flush();
        return outboxRef.current.autoAt !== at;
      } catch {
        return false;
      }
    },
    [flush, persist],
  );

  const resetSeen = useCallback(async (): Promise<boolean> => {
    try {
      if (!liveRef.current.available || !liveRef.current.loaded || !userRef.current) return false;
      const userAtSend = userRef.current;
      if (flushingRef.current) await flushingRef.current;
      const res = await api.auth.updateTourPrefs({ resetSeen: true, autoEnabled: true });
      if (userRef.current !== userAtSend) return false;
      resetAtRef.current = Date.now();
      sessionSeenRef.current = new Set();
      sessionAutoRef.current = true;
      outboxRef.current = { seen: [] };
      persist();
      serverRef.current = asPrefs(res) ?? { autoEnabled: true, seen: [] };
      bump();
      return true;
    } catch {
      return false;
    }
  }, [persist]);

  const value = useMemo<TourPrefs>(() => {
    if (!available) return NOOP_PREFS;
    const server = serverRef.current;
    const box = outboxRef.current;
    const seen = new Set<string>([...(server?.seen ?? []), ...box.seen, ...Array.from(sessionSeenRef.current)]);
    const auto = sessionAutoRef.current ?? freshAuto(box) ?? server?.autoEnabled ?? false;
    return {
      available: true,
      loaded,
      autoEnabled: loaded ? auto : false,
      seen: Array.from(seen),
      markSeen,
      setAutoEnabled,
      resetSeen,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, loaded, version, markSeen, setAutoEnabled, resetSeen]);

  return <TourPrefsContext.Provider value={value}>{children}</TourPrefsContext.Provider>;
}
