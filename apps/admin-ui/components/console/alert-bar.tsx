'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import type { ConsoleAlertFeed } from '@/lib/console-alert-types';
import { timeAgo } from '@/components/console/format';
import { cn } from '@/lib/utils';

const POLL_MS = 60_000;

/**
 * The red bar across the top of the root console. It lists what the operator
 * has to know about: events (an automatic volume growth, a refused restore)
 * that stay until acknowledged, and conditions (a disk past its threshold, a
 * silent autopilot) that are true right now and clear themselves.
 *
 * Fixed rather than sticky, like the sidebar: html/body set overflow-x hidden,
 * which breaks sticky. A spacer of the same height keeps the page below it.
 */
export function ConsoleAlertBar() {
  const [feed, setFeed] = useState<ConsoleAlertFeed | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.console
      .alerts()
      .then(setFeed)
      .catch(() => {
        // Keep the last feed: a transient failure must not hide a live alert.
      });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  async function acknowledge(id: string | 'all') {
    setBusy(id);
    try {
      if (id === 'all') await api.console.acknowledgeAllAlerts();
      else await api.console.acknowledgeAlert(id);
      load();
    } catch {
      // Left in place; the next poll shows whatever the server holds.
    } finally {
      setBusy(null);
    }
  }

  const alerts = feed?.alerts ?? [];
  const conditions = feed?.conditions ?? [];
  const count = alerts.length + conditions.length;
  if (count === 0) return null;

  const headline = conditions[0]?.title ?? alerts[0]?.title;
  const headlineAt = conditions.length === 0 ? alerts[0]?.occurredAt : null;

  return (
    <>
      <div className="fixed left-60 right-0 top-0 z-20">
        <div className="flex h-11 items-center gap-3 bg-red-600 px-6 text-sm text-white shadow-md">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-bold text-red-700">
            {count} {count === 1 ? 'alert' : 'alerts'}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {headline}
            {headlineAt && <span className="ml-2 font-normal text-red-100">{timeAgo(headlineAt)}</span>}
          </span>
          {alerts.length > 1 && (
            <button
              onClick={() => acknowledge('all')}
              disabled={busy !== null}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-50 hover:bg-white/15 disabled:opacity-60"
            >
              Acknowledge all
            </button>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex shrink-0 items-center gap-1 rounded-md bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
          >
            {open ? 'Hide' : 'Details'}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        </div>

        {open && (
          <div className="max-h-[70vh] overflow-y-auto border-b border-red-200 bg-background shadow-lg dark:border-red-900">
            <ul className="divide-y">
              {conditions.map((c) => (
                <li key={c.key} className="flex gap-3 px-6 py-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-600" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-red-700 dark:text-red-400">{c.title}</div>
                    <div className="text-sm text-muted-foreground">{c.detail}</div>
                  </div>
                  <span className="shrink-0 self-start rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-red-700 dark:bg-red-950 dark:text-red-300">
                    Now
                  </span>
                </li>
              ))}
              {alerts.map((a) => (
                <li key={a.id} className="flex gap-3 px-6 py-3">
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                      a.severity === 'critical' ? 'bg-red-600' : 'bg-amber-500',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{a.title}</div>
                    {a.detail && <div className="text-sm text-muted-foreground">{a.detail}</div>}
                    <div className="mt-1 text-xs text-muted-foreground" title={a.occurredAt}>
                      {new Date(a.occurredAt).toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · {timeAgo(a.occurredAt)} ·{' '}
                      {a.source === 'storage-autopilot' ? 'storage autopilot' : 'platform'}
                    </div>
                  </div>
                  <button
                    onClick={() => acknowledge(a.id)}
                    disabled={busy !== null}
                    className="flex shrink-0 items-center gap-1 self-start rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Acknowledge
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="h-11" aria-hidden />
    </>
  );
}
