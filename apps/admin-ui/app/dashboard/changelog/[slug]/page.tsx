import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getChangelogEntry, listChangelogEntries, renderMarkdown, KIND_BADGE_CLASS, KIND_LABEL } from '@/lib/changelog';
import { ArrowLeft } from 'lucide-react';

export const dynamic = 'force-static';
export const revalidate = 60;

export function generateStaticParams() {
  return listChangelogEntries().map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const entry = getChangelogEntry(slug);
  if (!entry) return {};
  return { title: entry.title, description: entry.summary };
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch { return dateStr; }
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = getChangelogEntry(slug);
  if (!entry) notFound();

  return (
    <div className="mx-auto w-full max-w-2xl py-8 sm:py-12">
      {/* Back link */}
      <Link
        href="/dashboard/changelog"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All updates
      </Link>

      {/* Header */}
      <header className="mt-6 border-b border-border pb-8">
        <div className="flex items-center gap-3">
          <span className={'inline-block rounded-full px-3 py-1 text-xs font-medium ' + KIND_BADGE_CLASS[entry.kind]}>
            {KIND_LABEL[entry.kind]}
          </span>
          <time className="text-sm text-muted-foreground" dateTime={entry.date}>
            {formatDate(entry.date)}
          </time>
        </div>
        <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          {entry.title}
        </h1>
        {entry.summary && (
          <p className="mt-3 text-lg leading-relaxed text-muted-foreground">
            {entry.summary}
          </p>
        )}
      </header>

      {/* Article body */}
      <article
        className="changelog-prose mt-8"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.body) }}
      />
    </div>
  );
}
