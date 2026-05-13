import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getChangelogEntry, listChangelogEntries, renderMarkdown, KIND_BADGE_CLASS, KIND_LABEL } from '@/lib/changelog';

export const dynamic = 'force-static';
export const revalidate = 60;

export function generateStaticParams() {
  return listChangelogEntries().map((e) => ({ slug: e.slug }));
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = getChangelogEntry(slug);
  if (!entry) notFound();
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <Link href="/changelog" className="text-sm text-muted-foreground">Back</Link>
      <span className={'mt-4 inline-block rounded px-2 py-0.5 text-xs ' + KIND_BADGE_CLASS[entry.kind]}>{KIND_LABEL[entry.kind]}</span>
      <h1 className="mt-2 text-3xl font-bold">{entry.title}</h1>
      <article dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.body) }} />
    </main>
  );
}
