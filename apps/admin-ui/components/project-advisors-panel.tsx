'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Copy, Gauge, Lightbulb, Loader2, RefreshCw, Shield } from 'lucide-react';
import { api } from '@/lib/api';
import type { AdvisorCategory, AdvisorFinding, AdvisorReport, AdvisorSeverity } from '@/lib/advisors';
import { useProject } from '@/contexts/project-context';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const CATEGORIES: { key: AdvisorCategory; label: string; icon: typeof Shield }[] = [
  { key: 'security', label: 'Security', icon: Shield },
  { key: 'performance', label: 'Performance', icon: Gauge },
];

const SEVERITY_STYLE: Record<AdvisorSeverity, { label: string; className: string }> = {
  error: { label: 'Error', className: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400' },
  warn: { label: 'Warning', className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  info: { label: 'Info', className: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400' },
};

function SeverityBadge({ severity }: { severity: AdvisorSeverity }) {
  const s = SEVERITY_STYLE[severity];
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium', s.className)}>
      {s.label}
    </span>
  );
}

function FindingCard({ finding }: { finding: AdvisorFinding }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(finding.fixSql);
      toast.success('Fix SQL copied');
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  }

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{finding.title}</p>
          <p className="break-all font-mono text-xs text-muted-foreground">{finding.entity}</p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{finding.detail}</p>
      <div className="rounded-md border bg-muted/40">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <span className="text-xs font-medium text-muted-foreground">Suggested fix (review before running)</span>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={copy}>
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
          </Button>
        </div>
        <pre className="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-xs">{finding.fixSql}</pre>
      </div>
      {finding.docsHint && <p className="text-xs text-muted-foreground">{finding.docsHint}</p>}
    </li>
  );
}

/**
 * Security and performance advisors (#218): a read-only scan of the project
 * database. Fixes are shown to copy into the SQL editor; nothing runs from here.
 */
export function ProjectAdvisorsPanel({ projectId }: { projectId: string }) {
  const { project } = useProject();
  const [report, setReport] = useState<AdvisorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNoSql = project?.databaseType === 'NOSQL';

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        setReport(await api.projects.advisors(projectId, { refresh }));
      } catch (err: any) {
        setError(err?.message || 'Could not scan the database');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (isNoSql) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, isNoSql]);

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Lightbulb className="h-4 w-4" /> Advisors
          </h2>
          <p className="text-xs text-muted-foreground">
            Checks your database schema for security and performance problems. The scan only reads the catalog; each
            finding comes with SQL you can review and run yourself in the SQL editor.
          </p>
          {report && (
            <p className="mt-1 text-xs text-muted-foreground">Last scanned {formatDateTime(report.generatedAt)}</p>
          )}
        </div>
        {!isNoSql && (
          <Button size="sm" variant="outline" onClick={() => load(true)} disabled={loading || refreshing}>
            {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        )}
      </div>

      {isNoSql ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          Advisors check relational databases. This project uses a document database.
        </p>
      ) : loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Scanning the database…
        </div>
      ) : error ? (
        <div className="space-y-3 rounded-lg border border-destructive/40 p-4 text-sm">
          <p className="text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={() => load(true)}>
            Try again
          </Button>
        </div>
      ) : report && report.findings.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border py-10 text-center">
          <CheckCircle2 className="h-6 w-6 text-emerald-500" />
          <p className="text-sm font-medium">No issues found</p>
          <p className="text-xs text-muted-foreground">Your schema passes every security and performance check.</p>
        </div>
      ) : report ? (
        <div className="space-y-6">
          {CATEGORIES.map(({ key, label, icon: Icon }) => {
            const items = report.findings.filter((f) => f.category === key);
            return (
              <div key={key} className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Icon className="h-4 w-4" /> {label}
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                    {items.length}
                  </span>
                </h3>
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No {label.toLowerCase()} issues found.</p>
                ) : (
                  <ul className="space-y-3">
                    {items.map((f) => (
                      <FindingCard key={f.id} finding={f} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {report && report.skippedRules.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Some checks could not run: {report.skippedRules.map((s) => `${s.ruleId} (${s.reason})`).join(', ')}.
        </p>
      )}
    </section>
  );
}
