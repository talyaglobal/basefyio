import Link from 'next/link';
import {
  listChangelogEntries,
  KIND_BADGE_CLASS,
  KIND_LABEL,
} from '@/lib/changelog';

export const dynamic = 'force-static';
export const revalidate = 60; // 1 minute — entries change rarely.

export const metadata = {
  title: 'Changelog — Kolaybase',
  description:
    'Surum notlari. Yeni ozellikler, hata duzeltmeleri ve iyilestirmeler.',
};

export default function PublicChangelogPage() {
  const entries = listChangelogEntries();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-10 space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="text-muted-foreground">
          Yeni ozellikler, hata duzeltmeleri ve iyilestirmeler. Yeniden eskiye dogru
          siralanir.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Henuz girdi yok.</p>
      ) : (
        <ul className="space-y-6">
          {entries.map((entry) => (
            <li
              key={entry.slug}
              className="rounded-lg border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow"
            >
              <div className="flex flex-wrap items-baseline gap-3">
                <span
                  className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase ${KIND_BADGE_CLASS[entry.kind]}`}
                >
                  {KIND_LABEL[entry.kind]}
                </span>
                <time
                  dateTime={entry.date}
                  className="text-xs text-muted-foreground"
                >
                  {new Date(entry.date).toLocaleDateString('tr-TR', {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                  })}
                </time>
              </div>
              <h2 className="mt-2 text-xl font-semibold">
                <Link
                  href={`/changelog/${entry.slug}`}
                  className="hover:text-primary"
                >
                  {entry.title}
                </Link>
              </h2>
              {entry.summary ? (
                <p className="mt-2 text-sm text-muted-foreground">{entry.summary}</p>
              ) : null}
              <div className="mt-3">
                <Link
                  href={`/changelog/${entry.slug}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Detaylari oku &rarr;
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
