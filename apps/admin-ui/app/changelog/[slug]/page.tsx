import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getChangelogEntry,
  listChangelogEntries,
  renderMarkdown,
  KIND_BADGE_CLASS,
  KIND_LABEL,
} from '@/lib/changelog';

export const dynamic = 'force-static';
export const revalidate = 60;

export function generateStaticParams() {
  return listChangelogEntries().map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = getChangelogEntry(slug);
  if (!entry) return { title: 'Changelog - Kolaybase' };
  return {
    title: `${entry.title} - Kolaybase Changelog`,
    description: entry.summary,
  };
}

export default async function ChangelogEntryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = getChangelogEntry(slug);
  if (!entry) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <nav className="mb-6 text-sm">
        <Link href="/changelog" className="text-muted-foreground hover:text-foreground">
          &larr; All entries
        </Link>
      </nav>

      <header className="mb-8 space-y-3 border-b border-border pb-6">
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
        <h1 className="text-3xl font-bold tracking-tight">{entry.title}</h1>
        {entry.summary ? (
          <p className="text-lg text-muted-foreground">{entry.summary}</p>
        ) : null}
      </header>

      <article
        className="changelog-body space-y-4 text-sm leading-relaxed text-foreground"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.body) }}
      />

      <style>
        {`.changelog-body h2 { font-size: 1.25rem; font-weight: 600; margin-top: 1.75rem; }
          .changelog-body h3 { font-size: 1.05rem; font-weight: 600; margin-top: 1.25rem; }
          .changelog-body p { line-height: 1.65; }
          .changelog-body ul, .changelog-body ol { margin-left: 1.25rem; line-height: 1.65; }
          .changelog-body ul { list-style: disc; }
          .changelog-body ol { list-style: decimal; }
          .changelog-body li { margin-top: 0.25rem; }
          .changelog-body code { background: hsl(var(--muted)); padding: 0 0.3rem; border-radius: 0.25rem; font-size: 0.85em; }
          .changelog-body pre { background: hsl(var(--muted)); padding: 0.75rem 1rem; border-radius: 0.5rem; overflow-x: auto; margin: 1rem 0; }
          .changelog-body pre code { background: transparent; padding: 0; }
          .changelog-body a { color: hsl(var(--primary)); text-decoration: underline; }
          .changelog-body table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.85rem; }
          .changelog-body th, .changelog-body td { border: 1px solid hsl(var(--border)); padding: 0.5rem 0.75rem; text-align: left; }
          .changelog-body th { background: hsl(var(--muted) / 0.5); font-weight: 600; }`}
      </style>
    </main>
  );
}
round: hsl(var(--muted) / 0.5); font-weight: 600; }`}
      </style>
    </main>
  );
}
