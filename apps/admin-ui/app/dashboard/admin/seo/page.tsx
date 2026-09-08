'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { useDashboard } from '@/app/dashboard/layout';
import { getAccessToken } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SeoAuditResult, Severity } from '@/lib/seo-audit';

const SEVERITY_STYLE: Record<Severity, { label: string; chip: string; icon: typeof AlertTriangle }> = {
  high: {
    label: 'High',
    chip: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
    icon: AlertTriangle,
  },
  medium: {
    label: 'Medium',
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    icon: AlertTriangle,
  },
  low: {
    label: 'Low',
    chip: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    icon: Info,
  },
};

const CATEGORY_LABEL: Record<string, string> = {
  crawlability: 'Crawlability',
  'on-page': 'On-page',
  geo: 'AI search (GEO)',
  performance: 'Performance',
};

function EndpointPill({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span
          className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-red-500')}
          aria-hidden
        />
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{detail}</div>
    </div>
  );
}

export default function SeoManagerPage() {
  const { profile } = useDashboard();
  const router = useRouter();
  const isRoot = profile?.role === 'ROOT';

  const [result, setResult] = useState<SeoAuditResult | null>(null);
  const [loading, setLoading] = useState(false);

  const runAudit = useCallback(async () => {
    setLoading(true);
    try {
      const token = getAccessToken();
      const res = await fetch('/api/seo/audit', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Audit failed (${res.status})`);
      }
      setResult(await res.json());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Audit failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // ROOT-only page; bounce others.
    if (profile && !isRoot) {
      router.replace('/dashboard');
      return;
    }
    if (isRoot) runAudit();
  }, [profile, isRoot, runAudit, router]);

  if (!profile || !isRoot) return null;

  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of result?.findings ?? []) counts[f.severity]++;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <button
          onClick={() => router.push('/dashboard/admin')}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Admin
        </button>
        <Button variant="outline" size="sm" onClick={runAudit} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
          )}
          Run audit
        </Button>
      </div>

      <div className="flex items-start gap-2">
        <Search className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h1 className="text-base font-semibold">SEO Manager</h1>
          <p className="text-sm text-muted-foreground">
            Audits the live site the way a crawler sees it — no Search Console or paid research
            account required. For click and impression data, see{' '}
            <Link
              href="/dashboard/admin"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Admin → Search Console
            </Link>
            .
          </p>
        </div>
      </div>

      {loading && !result ? (
        <div className="flex justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        </div>
      ) : !result ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
          No audit has run yet.
        </div>
      ) : (
        <>
          {!result.healthy && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium text-amber-600 dark:text-amber-400">Incomplete run</p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {result.runNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <EndpointPill
              label="robots.txt"
              ok={result.endpoints.robots.ok}
              detail={result.endpoints.robots.ok ? 'Serving' : `HTTP ${result.endpoints.robots.status}`}
            />
            <EndpointPill
              label="Sitemap URLs"
              ok={result.endpoints.sitemap.ok}
              detail={String(result.endpoints.sitemap.urlCount)}
            />
            <EndpointPill
              label="llms.txt"
              ok={result.endpoints.llms.ok}
              detail={result.endpoints.llms.ok ? 'Serving' : `HTTP ${result.endpoints.llms.status}`}
            />
            <EndpointPill
              label="Pages sampled"
              ok={result.pages.failed === 0}
              detail={`${result.pages.sampled - result.pages.failed}/${result.pages.sampled}`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{result.siteUrl}</span>
            <span>·</span>
            <span>checked {new Date(result.checkedAt).toLocaleString()}</span>
            <span>·</span>
            <span>slowest page {result.pages.slowestMs} ms</span>
          </div>

          {result.findings.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>No findings. Every check the audit can make from outside passed.</span>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                {(['high', 'medium', 'low'] as Severity[]).map((s) =>
                  counts[s] > 0 ? (
                    <span
                      key={s}
                      className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', SEVERITY_STYLE[s].chip)}
                    >
                      {counts[s]} {SEVERITY_STYLE[s].label.toLowerCase()}
                    </span>
                  ) : null,
                )}
              </div>

              <ul className="space-y-2">
                {result.findings.map((f) => {
                  const style = SEVERITY_STYLE[f.severity];
                  const Icon = style.icon;
                  return (
                    <li key={f.id} className="rounded-xl border bg-card p-3">
                      <div className="flex items-start gap-2">
                        <Icon
                          className={cn(
                            'mt-0.5 h-4 w-4 shrink-0',
                            f.severity === 'high'
                              ? 'text-red-500'
                              : f.severity === 'medium'
                                ? 'text-amber-500'
                                : 'text-sky-500',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{f.issue}</span>
                            <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {CATEGORY_LABEL[f.category] ?? f.category}
                            </span>
                          </div>
                          <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                            {f.evidence}
                          </p>
                          <p className="mt-1.5 text-xs text-muted-foreground">{f.fix}</p>
                          {f.url && (
                            <a
                              href={f.url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                            >
                              Open page <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
