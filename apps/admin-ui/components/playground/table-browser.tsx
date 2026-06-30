'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Code2, Loader2, Plus, RefreshCw, Table2, Trash2 } from 'lucide-react';
import { runPlaygroundSql, type PlaygroundRunResult } from '@/lib/playground/engine';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePlayground } from './playground-provider';

const CREATE_TEMPLATE = `CREATE TABLE my_table (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  added timestamptz NOT NULL DEFAULT now()
);`;

function sqlLiteral(value: string, type: string): string {
  if (/bool/.test(type)) return /^(t|true|1|y|yes)$/i.test(value) ? 'TRUE' : 'FALSE';
  if (/int|numeric|decimal|real|double|serial|money/.test(type)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

export function TableBrowser() {
  const { tables, refreshTables, loadIntoEditor } = usePlayground();
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<PlaygroundRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createSql, setCreateSql] = useState(CREATE_TEMPLATE);
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertValues, setInsertValues] = useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = useState<unknown>(null);

  const selectQuery = useCallback(
    (name: string) => `SELECT * FROM "${name}" ORDER BY 1 LIMIT 100;`,
    [],
  );

  const browse = useCallback(
    async (name: string) => {
      setLoading(true);
      setData(await runPlaygroundSql(selectQuery(name)));
      setLoading(false);
    },
    [selectQuery],
  );

  // Default to the first table, and re-select when the table set changes.
  useEffect(() => {
    if (tables.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((cur) => (cur && tables.some((t) => t.name === cur) ? cur : tables[0].name));
  }, [tables]);

  useEffect(() => {
    if (selected) void browse(selected);
  }, [selected, browse]);

  const activeTable = tables.find((t) => t.name === selected) ?? null;
  const hasId = activeTable?.columns.some((c) => c.name === 'id') ?? false;

  async function runMutation(sql: string, successMsg: string) {
    const res = await runPlaygroundSql(sql);
    if (res.ok) {
      toast.success(successMsg);
      await refreshTables();
      if (selected) await browse(selected);
    } else {
      toast.error(res.error ?? 'Operation failed');
    }
    return res;
  }

  async function handleCreate() {
    const res = await runMutation(createSql, 'Table created');
    if (res.ok) {
      setCreateOpen(false);
      setCreateSql(CREATE_TEMPLATE);
    }
  }

  async function handleInsert() {
    if (!activeTable) return;
    const cols = activeTable.columns.filter((c) => c.name !== 'id');
    const provided = cols.filter((c) => (insertValues[c.name] ?? '').trim() !== '');
    const sql = provided.length
      ? `INSERT INTO "${activeTable.name}" (${provided.map((c) => `"${c.name}"`).join(', ')})
VALUES (${provided.map((c) => sqlLiteral(insertValues[c.name].trim(), c.type)).join(', ')})
RETURNING *;`
      : `INSERT INTO "${activeTable.name}" DEFAULT VALUES RETURNING *;`;
    const res = await runMutation(sql, 'Row inserted');
    if (res.ok) {
      setInsertOpen(false);
      setInsertValues({});
    }
  }

  async function handleDelete(idValue: unknown) {
    if (!activeTable || !hasId) return;
    setDeletingId(idValue);
    const literal = typeof idValue === 'number' ? String(idValue) : `'${String(idValue).replace(/'/g, "''")}'`;
    await runMutation(`DELETE FROM "${activeTable.name}" WHERE id = ${literal};`, 'Row deleted');
    setDeletingId(null);
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Table list */}
      <div className="flex w-52 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">Tables</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void refreshTables()}
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {tables.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => setSelected(t.name)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                selected === t.name
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60',
              )}
            >
              <span className="flex items-center gap-1.5 truncate">
                <Table2 className="h-3.5 w-3.5 shrink-0" />
                {t.name}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {t.rowCount}
              </span>
            </button>
          ))}
        </div>
        <div className="border-t p-2">
          <Button variant="outline" size="sm" className="w-full" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New table
          </Button>
        </div>
      </div>

      {/* Data grid */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="truncate text-sm font-medium">{selected ?? 'No table selected'}</span>
          <div className="flex items-center gap-2">
            {selected && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => loadIntoEditor(selectQuery(selected))}
                title="Open in SQL editor"
              >
                <Code2 className="mr-1.5 h-3.5 w-3.5" /> SQL
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => {
                setInsertValues({});
                setInsertOpen(true);
              }}
              disabled={!activeTable}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Insert row
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : data && data.ok ? (
            <div className="overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0">
                  <tr className="border-b bg-muted">
                    {data.fields.map((f) => (
                      <th key={f.name} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                        {f.name}
                      </th>
                    ))}
                    {hasId && <th className="w-10 px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/40">
                      {data.fields.map((f) => (
                        <td key={f.name} className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                          {row[f.name] === null || row[f.name] === undefined ? (
                            <span className="text-muted-foreground/60">NULL</span>
                          ) : (
                            String(row[f.name])
                          )}
                        </td>
                      ))}
                      {hasId && (
                        <td className="px-2 py-1.5 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            disabled={deletingId === row.id}
                            onClick={() => void handleDelete(row.id)}
                            title="Delete row"
                          >
                            {deletingId === row.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {data.rows.length === 0 && (
                    <tr>
                      <td colSpan={data.fields.length + (hasId ? 1 : 0)} className="px-3 py-6 text-center text-muted-foreground">
                        No rows. Use “Insert row” to add one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {data?.error ?? 'Select a table to browse its rows.'}
            </div>
          )}
        </div>
      </div>

      {/* Create table dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create table</DialogTitle>
          </DialogHeader>
          <textarea
            value={createSql}
            onChange={(e) => setCreateSql(e.target.value)}
            spellCheck={false}
            className="h-44 w-full resize-y rounded-md border bg-muted/30 p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Insert row dialog */}
      <Dialog open={insertOpen} onOpenChange={setInsertOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Insert into {activeTable?.name}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-3 overflow-auto py-1">
            {activeTable?.columns
              .filter((c) => c.name !== 'id')
              .map((c) => (
                <div key={c.name} className="space-y-1">
                  <Label htmlFor={`ins-${c.name}`} className="flex items-center justify-between">
                    <span>{c.name}</span>
                    <span className="font-mono text-[11px] font-normal text-muted-foreground">{c.type}</span>
                  </Label>
                  <Input
                    id={`ins-${c.name}`}
                    value={insertValues[c.name] ?? ''}
                    onChange={(e) =>
                      setInsertValues((prev) => ({ ...prev, [c.name]: e.target.value }))
                    }
                    placeholder="leave blank for default"
                  />
                </div>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInsertOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleInsert()}>Insert</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
