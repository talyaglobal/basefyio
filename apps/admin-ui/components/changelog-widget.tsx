'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';

const STORAGE_KEY = 'kb_changelog_last_seen';

export function ChangelogWidget() {
  const [latestDate, setLatestDate] = useState<string | null>(null);
  const [hasUnseen, setHasUnseen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/changelog/latest')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const d = data && data.latest && data.latest.date;
        if (d) setLatestDate(d);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!latestDate) { setHasUnseen(false); return; }
    try {
      const seen = localStorage.getItem(STORAGE_KEY);
      setHasUnseen(!seen || seen < latestDate);
    } catch { setHasUnseen(false); }
  }, [latestDate]);

  function markSeen() {
    if (!latestDate) return;
    try { localStorage.setItem(STORAGE_KEY, latestDate); } catch {}
    setHasUnseen(false);
  }

  return (
    <Link href="/dashboard/changelog" onClick={markSeen} className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent" title="Changelog" aria-label="Changelog">
      <Sparkles className="h-4 w-4" />
      {hasUnseen ? <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" /> : null}
    </Link>
  );
}
