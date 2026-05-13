import Link from 'next/link';
import {
  listChangelogEntries,
  KIND_BADGE_CLASS,
  KIND_LABEL,
} from '@/lib/changelog';
import { ScrollText } from 'lucide-react';

export const dynamic = 'force-static';
export const revalidate = 60;

export const metadata = {
  title: 'Changelog - Kolaybase',
};

export default function DashboardChangelogPage() {
  const entries = listChangelogEntries();

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="mb-8 space-y-1">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ScrollText className="h-5 w-5" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Changelog
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          New features, bug fixes and improvements.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No entries yet.</p>
      ) : (
        <ul className="space-y-4">
          {entries.map((entry) => (
            <li
              key={entry.slug}
              className="rounded-lg border border-border bg-card p-4 transition-shadow hover:shadow-sm"
            >
              <div className="flex flex-wrap items-baseline gap-3">
                <span
                  className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase ${KIND_BADGE_CLASS[entry.kind]}`}
                >
                  {KIND_LABEL[entry.kind]}
                </span>
                <time dateTime={entry.date} className="text-xs text-muted-foreground">
                  {new Date(entry.date).toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                  })}
                </time>
              </div>
              <h2 className="mt-2 text-lg font-semibold">
                <Link
                  href={`/dashboard/changelog/${entry.slug}`}
                  className="hover:text-primary"
                >
                  {entry.title}
                </Link>
              </h2>
              {entry.summary ? (
                <p className="mt-1.5 text-sm text-muted-foreground">{entry.summary}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
