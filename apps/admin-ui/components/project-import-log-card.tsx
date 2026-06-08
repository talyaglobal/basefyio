'use client';

import type { ProjectSupabaseImportLog } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  buildSupabaseImportIssuePrompt,
  dispatchbasefyioAiMessage,
} from '@/lib/basefyio-ai-events';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Database,
  HardDrive,
  RefreshCw,
  ScrollText,
  Shield,
  Sparkles,
} from 'lucide-react';

export interface ProjectImportLogCardProps {
  importLog: ProjectSupabaseImportLog;
  importLogFromBrowser: boolean;
  onReimport: () => void;
  projectId: string;
  projectName: string;
  /** Wider / taller log panel (overview & project logs page). */
  expandedLayout?: boolean;
  /**
   * Logs route: parent sets fixed height; card fills it and scrolls inside (no page-level scroll).
   * Omit outer max-height clamp when true.
   */
  fillParentHeight?: boolean;
  className?: string;
}

function AiFixButton({
  prompt,
  className,
}: {
  prompt: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        'h-7 shrink-0 gap-1 border-amber-300/80 bg-background/80 text-[11px] hover:bg-amber-100/80 dark:border-amber-800 dark:hover:bg-amber-950/40',
        className,
      )}
      title="Open AI assistant with context for likely causes and fixes"
      onClick={() => {
        dispatchbasefyioAiMessage({ message: prompt, mode: 'ask' });
        toast.message('AI assistant', { description: 'Opened with your import issue context.' });
      }}
    >
      <Sparkles className="h-3 w-3 text-primary" />
      <span className="hidden sm:inline">Potential fixes (AI)</span>
      <span className="sm:hidden">AI</span>
    </Button>
  );
}

export function ProjectImportLogCard({
  importLog,
  importLogFromBrowser,
  onReimport,
  projectId,
  projectName,
  expandedLayout = false,
  fillParentHeight = false,
  className,
}: ProjectImportLogCardProps) {
  const hasIssues =
    importLog.warnings.length > 0 ||
    importLog.database.failedTables.length > 0 ||
    importLog.auth.skipped > 0;

  /** Dedicated logs page: cap height to viewport; embedded overview: compact scroll. */
  const listScroll = expandedLayout
    ? 'min-h-0 flex-1 overflow-y-auto pr-1'
    : 'max-h-56 overflow-y-auto';

  return (
    <div
      className={cn(
        'flex w-full min-w-0 max-w-full flex-col gap-4 overflow-x-hidden rounded-xl border bg-card shadow-sm',
        expandedLayout &&
          fillParentHeight &&
          'min-h-0 flex-1 overflow-hidden',
        expandedLayout &&
          !fillParentHeight &&
          'max-h-[min(calc(100dvh-12rem),56rem)] min-h-0',
        !expandedLayout && 'rounded-lg p-5 shadow-none',
        expandedLayout && 'p-5',
        className,
      )}
    >
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ScrollText className="h-4 w-4 shrink-0" />
            Supabase Import Log
          </div>
          {importLog.completedAt && (
            <p className="mt-1 text-xs text-muted-foreground">
              Completed {new Date(importLog.completedAt).toLocaleString()}
            </p>
          )}
          {importLogFromBrowser && (
            <p className="mt-1 text-xs text-amber-700/90 dark:text-amber-500/90">
              Showing summary saved in this browser. Re-import or redeploy the API to persist logs on
              the server.
            </p>
          )}
        </div>
        <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
          <Badge variant="secondary" className="font-normal">
            <Database className="mr-1 h-3 w-3" />
            {importLog.database.tables} tables
          </Badge>
          <Badge variant="secondary" className="font-normal">
            <Shield className="mr-1 h-3 w-3" />
            {importLog.auth.users} users
          </Badge>
          <Badge variant="secondary" className="font-normal">
            <HardDrive className="mr-1 h-3 w-3" />
            {importLog.storage.objects} files
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onReimport}
          >
            <RefreshCw className="mr-1.5 h-3 w-3" />
            Re-import
          </Button>
        </div>
      </div>

      <p className="shrink-0 text-xs text-muted-foreground">
        {importLog.database.rows.toLocaleString()} rows copied &middot; {importLog.storage.buckets}{' '}
        storage bucket(s)
        {importLog.auth.skipped > 0 && (
          <>
            {' '}
            &middot; {importLog.auth.skipped} auth user(s) skipped
          </>
        )}
      </p>

      {hasIssues && (
        <div
          className={cn(
            'flex min-h-0 flex-col gap-3 rounded-lg border p-4',
            expandedLayout && 'min-h-0 flex-1 overflow-hidden',
            importLog.warnings.length > 0
              ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
              : 'border-border bg-muted/40',
          )}
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            <p
              className={cn(
                'text-xs font-medium',
                importLog.warnings.length > 0
                  ? 'text-amber-800 dark:text-amber-400'
                  : 'text-muted-foreground',
              )}
            >
              {importLog.warnings.length > 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Errors &amp; warnings ({importLog.warnings.length})
                </span>
              ) : (
                'Import notes'
              )}
            </p>
          </div>

          {importLog.warnings.length === 0 && importLog.auth.skipped > 0 && (
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 pb-3 dark:border-amber-800/30">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Auth: {importLog.auth.skipped} user(s) were not imported.
              </p>
              <AiFixButton
                prompt={buildSupabaseImportIssuePrompt({
                  projectName,
                  projectId,
                  kind: 'auth_skipped',
                  detail: `${importLog.auth.skipped} auth user(s) were skipped during Supabase import (not imported into Keycloak).`,
                })}
              />
            </div>
          )}

          {importLog.warnings.length === 0 && importLog.database.failedTables.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Database: could not import {importLog.database.failedTables.length} table(s):
              </p>
              <ul className="space-y-2 text-xs">
                {importLog.database.failedTables.map((table) => (
                  <li
                    key={table}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-background/60 px-2 py-1.5 dark:bg-background/20"
                  >
                    <span className="min-w-0 break-all font-mono text-[11px]">{table}</span>
                    <AiFixButton
                      prompt={buildSupabaseImportIssuePrompt({
                        projectName,
                        projectId,
                        kind: 'failed_table',
                        detail: table,
                      })}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {importLog.warnings.length > 0 && (
            <ul
              className={cn(
                'min-w-0 space-y-0 text-xs text-amber-900 dark:text-amber-300',
                listScroll,
              )}
              aria-label="Import log messages"
            >
              {importLog.warnings.map((line, i) => (
                <li
                  key={i}
                  className="flex gap-2 border-b border-amber-200/60 py-2 last:border-0 dark:border-amber-800/50"
                >
                  <span className="shrink-0 pt-0.5 font-mono text-[10px] text-amber-600 dark:text-amber-500">
                    {i + 1}.
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                    <span className="min-w-0 max-w-full break-words leading-relaxed [overflow-wrap:anywhere]">
                      {line}
                    </span>
                    <AiFixButton
                      className="self-start sm:shrink-0"
                      prompt={buildSupabaseImportIssuePrompt({
                        projectName,
                        projectId,
                        kind: 'warning',
                        detail: line,
                        lineIndex: i + 1,
                      })}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
