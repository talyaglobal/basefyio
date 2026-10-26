'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, ChevronRight, Search } from 'lucide-react';
import { api } from '@/lib/api';
import type { TechDocPage, TechDocSummary } from '@/lib/techdocs-types';
import { PageHeader, Spinner, ErrorState } from '@/components/console/ui';
import { formatDate, timeAgo } from '@/components/console/format';
import { MarkdownView } from '@/components/markdown-view';
import { cn } from '@/lib/utils';

/**
 * Technical docs: how the platform is built and run, page by page. The
 * pages come from the operator's sync script (see the Runbooks page); this
 * screen only reads them. The address carries the open page (?page=slug) so
 * a link to a page can be shared between root users.
 */
export default function TechDocsPage() {
  const [pages, setPages] = useState<TechDocSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, TechDocPage>>({});
  const [loadingBody, setLoadingBody] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.console
      .techDocs()
      .then((list) => {
        if (cancelled) return;
        setPages(list);
        const wanted = new URLSearchParams(window.location.search).get('page');
        const first = list.find((p) => p.slug === wanted) ?? list[0];
        if (first) setSlug(first.slug);
      })
      .catch((err: any) => !cancelled && setError(err?.message || 'Could not load the technical docs'));
    return () => {
      cancelled = true;
    };
  }, []);

  const open = useCallback(
    async (next: string) => {
      setSlug(next);
      const url = new URL(window.location.href);
      url.searchParams.set('page', next);
      window.history.replaceState(null, '', url.toString());
      if (bodies[next]) return;
      setLoadingBody(true);
      try {
        const page = await api.console.techDoc(next);
        setBodies((b) => ({ ...b, [next]: page }));
      } catch (err: any) {
        setError(err?.message || 'Could not load the page');
      } finally {
        setLoadingBody(false);
      }
    },
    [bodies],
  );

  useEffect(() => {
    if (slug && !bodies[slug]) void open(slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const sections = useMemo(() => {
    if (!pages) return [];
    const q = query.trim().toLowerCase();
    const visible = q
      ? pages.filter((p) => {
          const hay = `${p.title} ${p.summary} ${p.section} ${bodies[p.slug]?.body ?? ''}`.toLowerCase();
          return hay.includes(q);
        })
      : pages;
    const map = new Map<string, TechDocSummary[]>();
    for (const p of visible) {
      if (!map.has(p.section)) map.set(p.section, []);
      map.get(p.section)!.push(p);
    }
    return Array.from(map.entries());
  }, [pages, query, bodies]);

  const current = slug ? bodies[slug] : undefined;
  const currentMeta = pages?.find((p) => p.slug === slug);

  if (error && !pages) return <ErrorState message={error} />;
  if (!pages) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Technical docs"
        description="How basefyio is built and run: hosts and URLs, backend, frontend, data stores, deploy flow, environment, observability, runbooks. Updated with every shipped change."
      />

      {pages.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          <BookOpen className="mx-auto mb-2 h-6 w-6" />
          No pages yet. Run the techdocs sync to publish them.
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-4 lg:self-start">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pages"
                className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary"
              />
            </label>
            <nav className="mt-3 space-y-4 lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto">
              {sections.length === 0 && <p className="text-xs text-muted-foreground">Nothing matches.</p>}
              {sections.map(([section, list]) => (
                <div key={section}>
                  <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{section}</p>
                  <ul className="mt-1 space-y-0.5">
                    {list.map((p) => (
                      <li key={p.slug}>
                        <button
                          type="button"
                          onClick={() => open(p.slug)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                            p.slug === slug ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                          )}
                          title={p.summary}
                        >
                          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0', p.slug === slug ? 'opacity-100' : 'opacity-0')} />
                          <span className="truncate">{p.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          <section className="min-w-0">
            {currentMeta && (
              <div className="mb-4 border-b pb-3">
                <p className="text-xs text-muted-foreground">{currentMeta.section}</p>
                <h2 className="text-xl font-semibold">{currentMeta.title}</h2>
                {currentMeta.summary && <p className="mt-1 text-sm text-muted-foreground">{currentMeta.summary}</p>}
                <p className="mt-2 text-xs text-muted-foreground">
                  Updated {formatDate(currentMeta.updatedAt)} ({timeAgo(currentMeta.updatedAt)})
                  {currentMeta.sourceCommit && <> · from commit {currentMeta.sourceCommit}</>} · {(currentMeta.bytes / 1024).toFixed(1)} KB
                </p>
              </div>
            )}
            {loadingBody && !current ? (
              <Spinner />
            ) : current ? (
              <article className="rounded-lg border bg-card p-6">
                <MarkdownView md={current.body} />
              </article>
            ) : error ? (
              <ErrorState message={error} />
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
