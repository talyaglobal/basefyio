'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, Sparkles } from 'lucide-react';
import { useImportProgress } from '@/lib/import-progress-context';
import type { ChangelogKind } from '@/lib/changelog';

const DISMISSED_KEY = 'basefyio_changelog_popup_dismissed';
const SEEN_KEY = 'basefyio_changelog_last_seen';

interface LatestEntry {
  slug: string;
  date: string;
  title: string;
  version?: string;
  kind: ChangelogKind;
  summary: string;
}

const KIND_COLORS: Record<ChangelogKind, string> = {
  feature: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  bugfix: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  improvement: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  breaking: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const KIND_LABEL: Record<ChangelogKind, string> = {
  feature: 'New feature',
  bugfix: 'Bug fix',
  improvement: 'Improvement',
  breaking: 'Breaking change',
};

export function ChangelogPopup() {
  const [entry, setEntry] = useState<LatestEntry | null>(null);
  const [visible, setVisible] = useState(false);
  const { activeImport } = useImportProgress();

  useEffect(() => {
    let cancelled = false;

    fetch('/api/changelog/latest')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.latest) return;
        const latest = data.latest as LatestEntry;
        if (!latest.slug || !latest.date) return;

        try {
          const dismissed = localStorage.getItem(DISMISSED_KEY);
          if (dismissed && dismissed >= latest.date) return;
        } catch {}

        setEntry(latest);
        setVisible(true);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  function handleDismiss(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (entry) {
      try {
        localStorage.setItem(DISMISSED_KEY, entry.date);
      } catch {}
    }
    setVisible(false);
  }

  function handleClick() {
    if (entry) {
      try {
        localStorage.setItem(SEEN_KEY, entry.date);
        localStorage.setItem(DISMISSED_KEY, entry.date);
      } catch {}
    }
  }

  if (!visible || !entry || activeImport) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9998] animate-in slide-in-from-bottom-4 fade-in duration-300">
      <Link
        href={`/dashboard/changelog/${entry.slug}`}
        onClick={handleClick}
        className="group block w-80 rounded-xl border bg-white/95 dark:bg-zinc-900/95 shadow-lg backdrop-blur-sm transition-colors hover:border-primary/40"
      >
        <div className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
              What&apos;s New
            </div>
            <button
              onClick={handleDismiss}
              className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-2.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${KIND_COLORS[entry.kind]}`}>
                {KIND_LABEL[entry.kind]}
              </span>
              {entry.version && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  {entry.version}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm font-medium text-foreground leading-snug line-clamp-2">
              {entry.title}
            </p>
            {entry.summary && (
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">
                {entry.summary}
              </p>
            )}
          </div>

          <div className="mt-3 text-[11px] font-medium text-primary group-hover:underline">
            Read more &rarr;
          </div>
        </div>
      </Link>
    </div>
  );
}
