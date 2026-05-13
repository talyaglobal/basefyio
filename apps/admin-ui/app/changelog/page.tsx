import Link from 'next/link';
import { listChangelogEntries, KIND_BADGE_CLASS, KIND_LABEL } from '@/lib/changelog';

export const dynamic = 'force-static';
export const revalidate = 60;

export const metadata = { title: 'Changelog' };

export default function PublicChangelogPage() {
  const entries = listChangelogEntries();
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <h1 className="mb-6 text-3xl font-bold">Changelog</h1>
      {entries.length === 0 ? <p>No entries yet.</p> : (
        <ul className="space-y-4">
          {entries.map((e) => (
            <li key={e.slug} className="rounded-lg border p-4">
              <span className={'inline-block rounded px-2 py-0.5 text-xs ' + KIND_BADGE_CLASS[e.kind]}>{KIND_LABEL[e.kind]}</span>
              <h2 className="mt-2 text-lg font-semibold"><Link href={'/changelog/' + e.slug}>{e.title}</Link></h2>
              <p className="text-sm text-muted-foreground">{e.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
