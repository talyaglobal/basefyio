'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';

const STORAGE_KEY = 'kb_changelog_last_seen';

/**
 * "What's new" header button. Renders a red dot when there are unseen
 * changelog entries. Clicking it navigates to /dashboard/changelog AND
 * stamps the localStorage key with the latest entry's date, so the dot
 * disappears until the next release.
 *
 * Why localStorage instead of server-side tracking: changelog visibility is
 * a UX nicety, not a privacy or auth concern. Per-device tracking is good
 * enough — if a user opens a new browser, the dot reappears, which is the
 * right behaviour ("I haven't seen this on this device").
 */
export function ChangelogWidget() {
  const [latestDate, setLatestDate] = useState<string | null>(null);
  const [hasUnseen, setHasUnseen] = useState(false);

  // Fetch the newest entry's date once on mount. The /api/changelog/latest
  // route is cached for 1 minute so navigating across pages doesn't hammer
  // the filesystem.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/changelog/latest')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const d = data?.latest?.date as string | undefined;
        if (d) setLatestDate(d);
      })
      .catch(() => {
        // Network errors are non-fatal; just skip the unread dot.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!latestDate) {
      setHasUnseen(false);
      return;
    }
    try {
      const seen = localStorage.getItem(STORAGE_KEY);
      setHasUnseen(!seen || seen < latestDate);
    } catch {
      setHasUnseen(false);
    }
  }, [latestDate]);

  function markSeen() {
    if (!latestDate) return;
    try {
      localStorage.setItem(STORAGE_KEY, latestDate);
    } catch {
      // localStorage can throw in private mode — swallow.
    }
    setHasUnseen(false);
  }

  return (
    <Link
      href="/dashboard/changelog"
      onClick={markSeen}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={hasUnseen ? 'New release notes available' : 'Changelog'}
      aria-label="Changelog"
    >
      <Sparkles className="h-4 w-4" />
      {hasUnseen ? (
        <span
          aria-hidden
          className="absolute right-1.5 top-1.5 inline-block h-2 w-2 rounded-full bg-red-500 ring-2 ring-background"
        />
      ) : null}
    </Link>
  );
}
);
}
red-500 ring-2 ring-background"
        />
      ) : null}
    </Link>
  );
}
;
}
