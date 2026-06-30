import { NextResponse } from 'next/server';
import { listChangelogEntries } from '@/lib/changelog';

export const revalidate = 60;

/** Returns all changelog entries (without rendered body) for the client-side list page. */
export async function GET() {
  const entries = listChangelogEntries().map(({ body: _, ...rest }) => rest);
  return NextResponse.json(entries);
}
