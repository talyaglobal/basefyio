'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Radio } from 'lucide-react';

interface RealtimeSettingsCardProps {
  projectId: string;
}

interface EntityRow {
  kind: 'table' | 'collection';
  entity: string;
  enabled: boolean;
}

/**
 * Per-entity realtime opt-in (Supabase publication model): only enabled
 * tables/collections broadcast INSERT/UPDATE/DELETE events to SDK clients.
 */
export function RealtimeSettingsCard({ projectId }: RealtimeSettingsCardProps) {
  const [rows, setRows] = useState<EntityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tables, collections, bindings] = await Promise.all([
        api.projects.tables(projectId).catch(() => []),
        api.projects.listCollections(projectId).catch(() => []),
        api.projects.listRealtimeBindings(projectId).catch(() => []),
      ]);
      const enabled = new Set(bindings.map((b) => `${b.kind}:${b.entity}`));
      const next: EntityRow[] = [
        ...tables
          .filter((t: { name: string; schema?: string }) => !t.schema || t.schema === 'public')
          .map((t: { name: string }) => ({
            kind: 'table' as const,
            entity: t.name,
            enabled: enabled.has(`table:${t.name}`),
          })),
        ...collections.map((c: { name: string }) => ({
          kind: 'collection' as const,
          entity: c.name,
          enabled: enabled.has(`collection:${c.name}`),
        })),
      ];
      setRows(next);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(row: EntityRow) {
    const key = `${row.kind}:${row.entity}`;
    setTogglingKey(key);
    try {
      await api.projects.setRealtimeBinding(projectId, {
        kind: row.kind,
        entity: row.entity,
        enabled: !row.enabled,
      });
      setRows((prev) =>
        prev.map((r) =>
          r.kind === row.kind && r.entity === row.entity ? { ...r, enabled: !r.enabled } : r,
        ),
      );
      toast.success(
        `Realtime ${row.enabled ? 'disabled' : 'enabled'} for ${row.entity}`,
      );
    } catch (err: any) {
      toast.error(err.message || 'Failed to update realtime setting');
    } finally {
      setTogglingKey(null);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-6">
      <div className="flex items-center gap-2">
        <Radio className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Realtime</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Enabled tables and collections broadcast INSERT / UPDATE / DELETE events to connected
        clients via{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">bf.realtime.subscribe()</code>.
        Events include full row data and are visible to anyone holding a project API key —
        enable only what your app should broadcast.
      </p>

      {loading ? (
        <div className="flex h-16 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tables or collections yet — create one first, then enable realtime here.
        </p>
      ) : (
        <div className="flex items-center justify-end gap-2 pb-1">
          <button
            type="button"
            className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
            disabled={togglingKey === '__all__' || rows.every((r) => r.enabled)}
            onClick={async () => {
              setTogglingKey('__all__');
              try {
                for (const row of rows.filter((r) => !r.enabled)) {
                  await api.projects.setRealtimeBinding(projectId, { kind: row.kind, entity: row.entity, enabled: true });
                }
                setRows((prev) => prev.map((r) => ({ ...r, enabled: true })));
                toast.success('Realtime enabled for all entities');
              } catch (err: any) {
                toast.error(err.message || 'Failed to enable all');
                void load();
              } finally {
                setTogglingKey(null);
              }
            }}
          >
            Select all
          </button>
          <span className="text-xs text-muted-foreground">·</span>
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:underline disabled:opacity-50"
            disabled={togglingKey === '__all__' || rows.every((r) => !r.enabled)}
            onClick={async () => {
              setTogglingKey('__all__');
              try {
                for (const row of rows.filter((r) => r.enabled)) {
                  await api.projects.setRealtimeBinding(projectId, { kind: row.kind, entity: row.entity, enabled: false });
                }
                setRows((prev) => prev.map((r) => ({ ...r, enabled: false })));
                toast.success('Realtime disabled for all entities');
              } catch (err: any) {
                toast.error(err.message || 'Failed to disable all');
                void load();
              } finally {
                setTogglingKey(null);
              }
            }}
          >
            Clear all
          </button>
        </div>
      )}
      {!loading && rows.length > 0 && (
        <div className="divide-y rounded-md border">
          {rows.map((row) => {
            const key = `${row.kind}:${row.entity}`;
            return (
              <div key={key} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-sm">{row.entity}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {row.kind}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={row.enabled}
                  disabled={togglingKey === key}
                  onClick={() => toggle(row)}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                    row.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                  }`}
                  title={row.enabled ? 'Disable realtime' : 'Enable realtime'}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      row.enabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
