'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { PrimaryKeyRepairResult, PrimaryKeyRepairSummary } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { KeyRound, Loader2 } from 'lucide-react';

export interface RepairPrimaryKeysDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  /** Called after keys were added, so the caller can refresh what it shows. */
  onRepaired?: () => void;
}

function describe(r: PrimaryKeyRepairResult): string {
  switch (r.status) {
    case 'present':
      return 'already has a primary key';
    case 'would_add':
      return `will add a key on (${r.columns.join(', ')})`;
    case 'added':
      return `key added on (${r.columns.join(', ')})`;
    case 'no_source_key':
      return 'the source has no primary key for this table';
    case 'column_missing':
      return r.error ?? 'a key column is missing here';
    case 'not_unique': {
      const parts: string[] = [];
      if (r.duplicateGroups) parts.push(`${r.duplicateGroups} duplicate value group(s)`);
      if (r.nullRows) parts.push(`${r.nullRows} row(s) with a null key column`);
      return `rows are not unique on (${r.columns.join(', ')}): ${parts.join(', ')}`;
    }
    case 'failed':
      return r.error ?? 'the statement was refused';
    case 'pending':
      return 'ran out of time; run again to continue';
  }
}

function tone(r: PrimaryKeyRepairResult): string {
  switch (r.status) {
    case 'added':
    case 'would_add':
      return 'text-emerald-700 dark:text-emerald-400';
    case 'not_unique':
    case 'failed':
    case 'column_missing':
      return 'text-amber-800 dark:text-amber-400';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * Preview, then apply: the source's primary keys on tables imported without one.
 *
 * The credentials are entered again because the platform keeps neither the
 * source URL nor its keys. Preview runs no DDL and lists what would happen per
 * table; Apply adds the keys the preview said it could.
 */
export function RepairPrimaryKeysDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onRepaired,
}: RepairPrimaryKeysDialogProps) {
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [serviceRoleKey, setServiceRoleKey] = useState('');
  const [databasePassword, setDatabasePassword] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [preview, setPreview] = useState<PrimaryKeyRepairSummary | null>(null);
  const [applied, setApplied] = useState<PrimaryKeyRepairSummary | null>(null);

  const canSubmit = supabaseUrl.trim() !== '' && serviceRoleKey.trim() !== '' && busy === null;

  function reset() {
    setPreview(null);
    setApplied(null);
  }

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'preview' : 'apply');
    try {
      const summary = await api.projects.repairSupabaseImportKeys(projectId, {
        supabaseUrl: supabaseUrl.trim().replace(/\/+$/, ''),
        serviceRoleKey: serviceRoleKey.trim(),
        ...(databasePassword.trim() ? { databasePassword: databasePassword.trim() } : {}),
        dryRun,
      });
      if (dryRun) {
        setPreview(summary);
        setApplied(null);
        if (summary.wouldAdd === 0) {
          toast.message('Nothing to add', {
            description:
              summary.examined === 0
                ? 'Every table already has a primary key.'
                : 'No table can be keyed as it is; see the list for why.',
          });
        }
      } else {
        setApplied(summary);
        if (summary.added > 0) {
          toast.success(`Primary key added to ${summary.added} table(s)`);
          onRepaired?.();
        }
        if (summary.pending > 0) {
          toast.message(`${summary.pending} table(s) still waiting`, {
            description: 'The run stopped at its time limit. Apply again to continue.',
          });
        }
        if (summary.failed > 0) {
          toast.warning(`${summary.failed} table(s) could not be keyed`);
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The repair could not run');
    } finally {
      setBusy(null);
    }
  }

  const shown = applied ?? preview;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <DialogTitle>Add missing primary keys</DialogTitle>
          </div>
          <DialogDescription>
            Tables imported into{' '}
            <span className="font-medium text-foreground">{projectName}</span> without a
            primary key get the source&apos;s key, where the rows here are unique on it. Preview
            first; nothing changes until you apply. Each repaired table is locked briefly while
            its index builds.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void run(true);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="repair-supabase-url">Supabase Project URL</Label>
            <Input
              id="repair-supabase-url"
              type="url"
              value={supabaseUrl}
              onChange={(e) => {
                setSupabaseUrl(e.target.value);
                reset();
              }}
              placeholder="https://xyzproject.supabase.co"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="repair-service-key">Service Role Key</Label>
            <PasswordInput
              id="repair-service-key"
              value={serviceRoleKey}
              onChange={(e) => {
                setServiceRoleKey(e.target.value);
                reset();
              }}
              placeholder="eyJhbGciOiJIUzI1NiIs..."
              name="supabase-service-role"
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              required
            />
            <p className="text-xs text-muted-foreground">
              The key names the primary key of every published table. Add the database password
              to read keys straight from the source catalogue instead.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="repair-db-password">Database password (optional)</Label>
            <PasswordInput
              id="repair-db-password"
              value={databasePassword}
              onChange={(e) => {
                setDatabasePassword(e.target.value);
                reset();
              }}
              name="supabase-db-password"
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
            />
          </div>

          {shown && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-medium">
                {applied
                  ? `Applied: ${applied.added} added, ${applied.skipped} skipped, ${applied.failed} failed${applied.pending ? `, ${applied.pending} pending` : ''}`
                  : `Preview: ${shown.wouldAdd} to add, ${shown.skipped} skipped of ${shown.examined} examined`}
              </p>
              {shown.results.length === 0 ? (
                <p className="text-xs text-muted-foreground">Every table already has a primary key.</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto text-xs" aria-label="Primary key repair results">
                  {shown.results.map((r) => (
                    <li key={r.table} className="flex flex-wrap items-baseline gap-x-2 border-b border-border/60 py-1 last:border-0">
                      <span className="font-mono text-[11px]">{r.table}</span>
                      <span className={cn('min-w-0 break-words', tone(r))}>{describe(r)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy !== null}>
              Close
            </Button>
            <Button type="submit" variant={preview && !applied ? 'outline' : 'default'} disabled={!canSubmit}>
              {busy === 'preview' ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Checking…
                </>
              ) : (
                'Preview'
              )}
            </Button>
            <Button
              type="button"
              disabled={!canSubmit || !preview || preview.wouldAdd === 0 || !!applied}
              onClick={() => void run(false)}
            >
              {busy === 'apply' ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Adding…
                </>
              ) : (
                `Apply${preview?.wouldAdd ? ` (${preview.wouldAdd})` : ''}`
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
