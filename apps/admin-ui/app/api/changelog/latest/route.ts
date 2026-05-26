import { NextResponse } from 'next/server';
import { listChangelogEntries, getLatestVersion } from '@/lib/changelog';

// Cache for 1 minute so the widget doesn't hammer the filesystem on every
// pageview. Entries are committed to git, not user-mutable, so staleness up
// to ~1 minute is harmless.
export const revalidate = 60;

/**
 * Returns just the metadata the "What's new" header dot needs: latest
 * entry's slug + date. Keeps payload tiny.
 */
export async function GET() {
  const entries = listChangelogEntries();
  if (entries.length === 0) {
    return NextResponse.json({ latest: null });
  }
  const top = entries[0];
  return NextResponse.json({
    latest: {
      slug: top.slug,
      date: top.date,
      title: top.title,
      version: top.version,
    },
    version: getLatestVersion(),
  });
}
