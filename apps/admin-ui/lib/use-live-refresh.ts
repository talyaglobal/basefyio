'use client';

/**
 * Live-refresh for project pages: every mutation already broadcasts a
 * project-channel activity event — this hook listens and re-runs the
 * caller's loader so any open tab reflects changes without a refresh.
 *
 * Kinds use prefix matching against the activity kind taxonomy
 * ('table.', 'storage.', 'auth.', 'collection.', 'project_export.', …);
 * pass [''] to react to every project event.
 */

import { useEffect, useRef } from 'react';
import { subscribebasefyioRealtime } from '@/lib/basefyio-realtime';
import type { RealtimeEventEnvelope } from '@/lib/realtime-types';

/**
 * `refresh` receives the events that triggered it (one debounce window's
 * worth), for callers that need to look closer — e.g. whether a SQL run
 * changed anything. Callers that ignore the argument are unaffected.
 */
export function useLiveProjectRefresh(
  projectId: string | undefined,
  kindPrefixes: string[],
  refresh: (events: RealtimeEventEnvelope[]) => void | Promise<void>,
  debounceMs = 300,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const prefixesKey = kindPrefixes.join('|');

  useEffect(() => {
    if (!projectId) return;
    const prefixes = prefixesKey.split('|').filter((p) => p !== undefined);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: RealtimeEventEnvelope[] = [];

    const unsubscribe = subscribebasefyioRealtime(`project:${projectId}`, (event) => {
      // The stream also carries the signed-in user's own channel, where events
      // about other projects arrive; only this project's count here.
      if (event.projectId ? event.projectId !== projectId : event.entityType === 'project' && event.entityId !== projectId) {
        return;
      }
      const kind = (event.payload as { kind?: string } | undefined)?.kind ?? '';
      if (!prefixes.some((p) => kind.startsWith(p))) return;
      pending.push(event);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const events = pending;
        pending = [];
        void refreshRef.current(events);
      }, debounceMs);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [projectId, prefixesKey, debounceMs]);
}
