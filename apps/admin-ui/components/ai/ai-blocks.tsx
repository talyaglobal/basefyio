'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Play,
  ShieldCheck,
  Table2,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AiApplyResult, AiProposalEvent, AiStatementResult } from '@/lib/ai-assistant';
import { Markdown } from './markdown';

/* ───────────────────────────── code ───────────────────────────── */

export function CodeBlock({
  code,
  lang,
  action,
}: {
  code: string;
  lang: string;
  /** Optional button next to Copy (Run / Review change). */
  action?: React.ReactNode;
}) {
  const isSql = ['sql', 'postgres', 'postgresql', 'pgsql', 'psql'].includes(lang);
  return (
    <div className="w-full rounded-lg border bg-zinc-950 overflow-hidden text-xs">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10">
        <span className="text-zinc-400 font-mono uppercase tracking-wider text-[10px]">{isSql ? 'SQL' : lang || 'code'}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(code);
              toast.success('Copied');
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Copy className="h-3 w-3" />
            <span className="text-[10px]">Copy</span>
          </button>
          {action}
        </div>
      </div>
      <pre className="p-3 overflow-x-auto text-zinc-200 font-mono leading-relaxed text-[11px] whitespace-pre-wrap break-words">
        {code}
      </pre>
    </div>
  );
}

/* ───────────────────────────── results ───────────────────────────── */

function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function ResultTable({ result }: { result: AiStatementResult }) {
  const fields = result.fields.length ? result.fields : Object.keys(result.rows[0] ?? {});
  if (!result.rows.length) return null;
  return (
    <div className="max-h-64 w-full overflow-auto rounded-md border bg-background">
      <table className="w-full text-left text-[11px]">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {fields.map((f) => (
              <th key={f} className="px-2 py-1 font-semibold whitespace-nowrap">
                {f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {result.rows.map((row, i) => (
            <tr key={i}>
              {fields.map((f) => {
                const text = cellText(row[f]);
                return (
                  <td
                    key={f}
                    className={cn('px-2 py-1 align-top font-mono whitespace-nowrap max-w-[220px] truncate', text === 'NULL' && 'text-muted-foreground')}
                    title={text}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What a statement did, in Postgres' own terms: rows returned vs rows affected. */
export function resultLabel(r: AiStatementResult): string {
  if (!r.ok) return 'Failed';
  const n = r.rowCount ?? 0;
  const rows = (word: string, count: number) => `${count} row${count === 1 ? '' : 's'} ${word}`;
  switch (r.command.toUpperCase()) {
    case 'SELECT':
      return rows('returned', r.rows.length) + (r.truncated ? ' (first 100 shown)' : '');
    case 'INSERT':
      return rows('inserted', n) + (r.rows.length ? `, ${r.rows.length} returned` : '');
    case 'UPDATE':
      return rows('updated', n) + (r.rows.length ? `, ${r.rows.length} returned` : '');
    case 'DELETE':
      return rows('deleted', n) + (r.rows.length ? `, ${r.rows.length} returned` : '');
    default:
      return r.command ? `${r.command} done` : 'Done';
  }
}

export function QueryResults({ sql, results, title }: { sql: string; results: AiStatementResult[]; title?: string }) {
  const [showSql, setShowSql] = useState(false);
  const failed = results.some((r) => !r.ok);
  return (
    <div className="w-full rounded-lg border bg-background/60 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setShowSql((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent transition-colors"
      >
        {failed ? <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" /> : <Table2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />}
        <span className="flex-1 text-left text-[11px] font-medium">
          {title ?? 'Read-only query'} · {results.map(resultLabel).join(' · ')}
        </span>
        {showSql ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
      </button>
      <div className="border-t space-y-2 p-2">
        {showSql && (
          <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-words bg-muted rounded p-1.5">{sql}</pre>
        )}
        {results.map((r, i) =>
          r.ok ? (
            <ResultTable key={i} result={r} />
          ) : (
            <p key={i} className="text-[11px] text-red-600 dark:text-red-400 break-words">
              {r.error}
            </p>
          ),
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── proposals ───────────────────────────── */

export type ProposalStatus = 'pending' | 'approving' | 'applied' | 'failed' | 'rejected' | 'expired' | 'invalid';

export interface ProposalState extends AiProposalEvent {
  status: ProposalStatus;
  outcome?: AiApplyResult | null;
  message?: string | null;
}

export function ProposalCard({
  proposal,
  onApprove,
  onReject,
  canAct,
}: {
  proposal: ProposalState;
  onApprove: () => void;
  onReject: () => void;
  /** False while another request for this panel is running. */
  canAct: boolean;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const destructive = proposal.statements.some((s) => s.destructive);
  const v = proposal.validation;

  const header: Record<ProposalStatus, { text: string; tone: string }> = {
    pending: { text: 'Change waiting for your approval — nothing has run yet', tone: 'text-amber-700 dark:text-amber-400' },
    approving: { text: 'Running the approved change…', tone: 'text-amber-700 dark:text-amber-400' },
    applied: { text: 'Applied and checked in the database', tone: 'text-emerald-700 dark:text-emerald-400' },
    failed: { text: 'Not applied', tone: 'text-red-600 dark:text-red-400' },
    rejected: { text: 'Discarded — nothing was run', tone: 'text-muted-foreground' },
    expired: { text: 'No longer available — ask again to get a fresh proposal', tone: 'text-muted-foreground' },
    invalid: { text: 'This SQL failed validation and cannot be approved', tone: 'text-red-600 dark:text-red-400' },
  };
  const h = header[proposal.status];

  return (
    <div
      className={cn(
        'w-full rounded-lg border overflow-hidden text-xs',
        proposal.status === 'pending' && (destructive ? 'border-red-300 dark:border-red-800' : 'border-amber-300 dark:border-amber-800'),
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        {proposal.status === 'applied' ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
        ) : proposal.status === 'failed' || proposal.status === 'invalid' ? (
          <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
        ) : proposal.status === 'approving' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5 text-amber-600 shrink-0" />
        )}
        <span className={cn('flex-1 text-[11px] font-semibold', h.tone)}>{h.text}</span>
      </div>

      <div className="p-2.5 space-y-2">
        <ul className="space-y-1">
          {proposal.statements.map((s, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span
                className={cn(
                  'shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-semibold uppercase',
                  s.destructive ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400' : 'bg-muted text-muted-foreground',
                )}
              >
                {s.command || s.kind}
              </span>
              {s.warning && (
                <span className="flex items-start gap-1 text-[10px] text-red-600 dark:text-red-400">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
                  {s.warning}
                </span>
              )}
            </li>
          ))}
        </ul>

        <CodeBlock code={proposal.sql} lang="sql" />

        {v.status === 'passed' && (
          <p className="flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400">
            <Check className="h-3 w-3" /> Checked against your database in a transaction that was rolled back.
          </p>
        )}
        {v.status === 'partial' && (
          <div className="text-[10px] text-muted-foreground space-y-0.5">
            <p className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
              <Check className="h-3 w-3" /> Checked against your database, except:
            </p>
            {v.notes.map((n, i) => (
              <p key={i} className="pl-4">
                {n}
              </p>
            ))}
          </div>
        )}
        {v.status === 'failed' && v.error && (
          <p className="text-[11px] text-red-600 dark:text-red-400 break-words">PostgreSQL rejected it: {v.error}</p>
        )}
        {proposal.correctedFrom && (
          <div className="text-[10px] text-muted-foreground">
            <button type="button" className="underline underline-offset-2" onClick={() => setShowOriginal((s) => !s)}>
              The first draft failed this check and was corrected{showOriginal ? ' — hide it' : ' — show it'}
            </button>
            {showOriginal && (
              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-1.5 font-mono">{proposal.correctedFrom}</pre>
            )}
          </div>
        )}

        {proposal.outcome && (
          <div className="rounded-md border bg-background p-2 space-y-2">
            <Markdown text={proposal.outcome.summary} renderCode={(code, lang, key) => <CodeBlock key={key} code={code} lang={lang} />} />
            {proposal.outcome.statements.map((s, i) =>
              s.ok && s.rows.length ? <ResultTable key={i} result={s} /> : null,
            )}
          </div>
        )}
        {proposal.message && !proposal.outcome && (
          <p className="text-[11px] text-muted-foreground break-words">{proposal.message}</p>
        )}

        {proposal.status === 'pending' && proposal.proposal && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={!canAct}
              onClick={onReject}
              className="rounded-md border px-2.5 py-1 text-[11px] font-medium hover:bg-accent disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={!canAct}
              onClick={onApprove}
              className={cn(
                'flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50',
                destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:opacity-90',
              )}
            >
              <Play className="h-3 w-3" />
              {destructive ? 'Approve destructive change' : 'Approve & run'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
