'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ChangelogEntry } from '@/lib/changelog';

const PAGE_SIZE = 5;

/** Soft SVG background — database / data-flow motif */
function TimelineBackground() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.03] dark:opacity-[0.04]"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <pattern id="tl-grid" width="60" height="60" patternUnits="userSpaceOnUse">
          <circle cx="30" cy="30" r="1.5" fill="currentColor" />
        </pattern>
        <pattern id="tl-db" width="240" height="200" patternUnits="userSpaceOnUse">
          <rect width="240" height="200" fill="url(#tl-grid)" />
          <ellipse cx="120" cy="60" rx="36" ry="10" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M84 60v50c0 5.5 16 10 36 10s36-4.5 36-10V60" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <ellipse cx="120" cy="110" rx="36" ry="10" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.5" />
          <line x1="120" y1="120" x2="120" y2="150" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" />
          <circle cx="120" cy="155" r="4" stroke="currentColor" strokeWidth="1" fill="none" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#tl-db)" />
    </svg>
  );
}

export default function DashboardChangelogPage() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/changelog')
      .then((r) => r.json())
      .then((data) => {
        setEntries(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const loadMore = useCallback(() => {
    setVisible((v) => Math.min(v + PAGE_SIZE, entries.length));
  }, [entries.length]);

  useEffect(() => {
    const el = loaderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const shown = entries.slice(0, visible);
  const hasMore = visible < entries.length;

  // Group by month
  const groups: { label: string; items: ChangelogEntry[] }[] = [];
  for (const entry of shown) {
    const d = new Date(entry.date + 'T00:00:00');
    const label = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(entry);
    } else {
      groups.push({ label, items: [entry] });
    }
  }

  const kindBadge: Record<string, { label: string; cls: string; dot: string }> = {
    feature: {
      label: 'New feature',
      cls: 'bg-gradient-to-r from-blue-500 to-blue-600 text-white',
      dot: 'bg-blue-500 shadow-blue-500/40',
    },
    bugfix: {
      label: 'Bug fix',
      cls: 'bg-gradient-to-r from-amber-500 to-orange-500 text-white',
      dot: 'bg-amber-500 shadow-amber-500/40',
    },
    improvement: {
      label: 'Improvement',
      cls: 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white',
      dot: 'bg-blue-500 shadow-blue-500/40',
    },
    breaking: {
      label: 'Breaking change',
      cls: 'bg-gradient-to-r from-red-500 to-pink-500 text-white',
      dot: 'bg-red-500 shadow-red-500/40',
    },
  };

  return (
    <div className="relative mx-auto w-full max-w-4xl">
      <TimelineBackground />

      <div className="relative">
        <h1 className="mb-2 text-2xl font-bold">Changelog</h1>
        <p className="mb-10 text-sm text-muted-foreground">
          Latest updates, new features, and improvements to basefyio.
        </p>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground">No entries yet.</p>
        ) : (
          <div className="space-y-12">
            {groups.map((group) => (
              <div key={group.label}>
                {/* Month header */}
                <div className="mb-6 flex items-center gap-4">
                  <span className="rounded-full bg-primary/10 px-4 py-1.5 text-sm font-bold text-primary">
                    {group.label}
                  </span>
                  <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
                </div>

                {/* Timeline — alternating left/right on desktop */}
                <div className="relative">
                  {/* Center line */}
                  <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-gradient-to-b from-primary/30 via-primary/15 to-transparent md:left-1/2 md:-translate-x-px" />

                  <div className="space-y-8 md:space-y-10">
                    {group.items.map((e, idx) => {
                      const badge = kindBadge[e.kind] || kindBadge.improvement;
                      const d = new Date(e.date + 'T00:00:00');
                      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                      const isLeft = idx % 2 === 0;

                      return (
                        <div key={e.slug} className="relative flex items-start md:justify-between">
                          {/* Timeline dot */}
                          <div
                            className={
                              'absolute left-5 top-6 z-10 h-4 w-4 -translate-x-1/2 rounded-full shadow-[0_0_12px] md:left-1/2 ' +
                              badge.dot
                            }
                          >
                            <div className="absolute inset-0.5 rounded-full bg-background" />
                            <div className={'absolute inset-1 rounded-full ' + badge.dot} />
                          </div>

                          {/* Date badge — opposite side, snug to the dot */}
                          <div
                            className={
                              'hidden md:flex md:w-[calc(50%-2rem)] items-start pt-5 ' +
                              (isLeft ? 'order-2 justify-start pl-3' : 'order-1 justify-end pr-3')
                            }
                          >
                            <span className="rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm whitespace-nowrap">
                              {dateStr}
                            </span>
                          </div>

                          {/* Card */}
                          <div
                            className={
                              'ml-10 flex-1 md:ml-0 md:w-[calc(50%-2rem)] ' +
                              (isLeft ? 'md:order-1 md:pr-10' : 'md:order-2 md:pl-10')
                            }
                          >
                            <Link
                              href={'/dashboard/changelog/' + e.slug}
                              className="group block overflow-hidden rounded-xl border bg-card shadow-sm transition-all duration-200 hover:shadow-md hover:border-primary/30 hover:-translate-y-0.5"
                            >
                              {/* Gradient top bar */}
                              <div className={'h-1 w-full ' + badge.cls.replace('text-white', '')} />

                              <div className="p-5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={'inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold shadow-sm ' + badge.cls}>
                                    {badge.label}
                                  </span>
                                  {e.version && (
                                    <span className="inline-block rounded-full border px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                                      {e.version}
                                    </span>
                                  )}
                                  <span className="text-xs text-muted-foreground md:hidden">{dateStr}</span>
                                </div>
                                <h2 className="mt-3 text-base font-bold leading-snug group-hover:text-primary transition-colors">
                                  {e.title}
                                </h2>
                                <p className="mt-2 text-sm leading-relaxed text-muted-foreground line-clamp-2">
                                  {e.summary}
                                </p>
                                <span className="mt-3 inline-flex items-center text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                                  Read more &rarr;
                                </span>
                              </div>
                            </Link>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}

            {/* Lazy load trigger */}
            {hasMore && (
              <div ref={loaderRef} className="flex justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            )}

            {/* Timeline end dot */}
            {!hasMore && entries.length > 0 && (
              <div className="flex justify-center">
                <div className="h-3 w-3 rounded-full bg-primary/20" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
