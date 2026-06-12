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

export function useLiveProjectRefresh(
  projectId: string | undefined,
  kindPrefixes: string[],
  refresh: () => void | Promise<void>,
  debounceMs = 300,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const prefixesKey = kindPrefixes.join('|');

  useEffect(() => {
    if (!projectId) return;
    const prefixes = prefixesKey.split('|').filter((p) => p !== undefined);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = subscribebasefyioRealtime(`project:${projectId}`, (event) => {
      const kind = (event.payload as { kind?: string } | undefined)?.kind ?? '';
      if (!prefixes.some((p) => kind.startsWith(p))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshRef.current();
      }, debounceMs);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [projectId, prefixesKey, debounceMs]);
}
