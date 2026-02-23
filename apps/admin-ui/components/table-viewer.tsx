'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TableInfo, ColumnInfo, TableRows } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { CreateTableDialog } from '@/components/create-table-dialog';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Key,
  Pencil,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  X,
} from 'lucide-react';

interface TableViewerProps {
  projectId: string;
}

export function TableViewer({ projectId }: TableViewerProps) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [data, setData] = useState<TableRows | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const [editingCell, setEditingCell] = useState<{ rowIdx: number; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addingRow, setAddingRow] = useState(false);
  const [newRow, setNewRow] = useState<Record<string, string>>({});
  const editRef = useRef<HTMLInputElement>(null);

  const pkColumns = columns.filter((c) => c.isPrimary).map((c) => c.name);

  useEffect(() => {
    loadTables();
  }, [projectId]);

  useEffect(() => {
    if (editRef.current) editRef.current.focus();
  }, [editingCell]);

  async function loadTables() {
    setLoading(true);
    try {
      const result = await api.projects.tables(projectId);
      setTables(result);
      if (result.length > 0) {
        const target =
          selected && result.some((t) => t.name === selected)
            ? selected
            : result[0].name;
        selectTable(target);
      } else {
        setSelected(null);
        setColumns([]);
        setData(null);
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function selectTable(name: string) {
    setSelected(name);
    setPage(1);
    setEditingCell(null);
    setAddingRow(false);
    setDataLoading(true);

    try {
      const [cols, rows] = await Promise.all([
        api.projects.columns(projectId, name),
        api.projects.rows(projectId, name, 1),
      ]);
      setColumns(cols);
      setData(rows);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDataLoading(false);
    }
  }

  async function reloadRows() {
    if (!selected) return;
    setDataLoading(true);
    try {
      const rows = await api.projects.rows(projectId, selected, page);
      setData(rows);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDataLoading(false);
    }
  }

  async function loadPage(p: number) {
    if (!selected) return;
    setPage(p);
    setEditingCell(null);
    setDataLoading(true);
    try {
      const rows = await api.projects.rows(projectId, selected, p);
      setData(rows);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDataLoading(false);
    }
  }

  async function handleDropTable(name: string) {
    if (!confirm(`Drop table "${name}"? This will delete all data permanently.`))
      return;
    try {
      await api.projects.dropTable(projectId, name);
      toast.success(`Table "${name}" dropped`);
      if (selected === name) setSelected(null);
      loadTables();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function getPkWhere(row: Record<string, unknown>): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    for (const pk of pkColumns) {
      where[pk] = row[pk];
    }
    return where;
  }

  function startEdit(rowIdx: number, field: string) {
    if (pkColumns.includes(field)) return;
    const val = data?.rows[rowIdx]?.[field];
    setEditingCell({ rowIdx, field });
    setEditValue(val === null ? '' : String(val));
  }

  async function commitEdit() {
    if (!editingCell || !selected || !data) return;
    const row = data.rows[editingCell.rowIdx];
    if (!row) return;

    const pkWhere = getPkWhere(row);
    if (!Object.keys(pkWhere).length) {
      toast.error('Cannot edit: table has no primary key');
      setEditingCell(null);
      return;
    }

    const oldVal = row[editingCell.field];
    const newVal = editValue === '' ? null : editValue;
    if (String(oldVal ?? '') === String(newVal ?? '')) {
      setEditingCell(null);
      return;
    }

    try {
      await api.projects.updateRow(projectId, selected, pkWhere, {
        [editingCell.field]: newVal,
      });
      toast.success('Cell updated');
      setEditingCell(null);
      reloadRows();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function cancelEdit() {
    setEditingCell(null);
  }

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  }

  function startAddRow() {
    const defaults: Record<string, string> = {};
    for (const col of columns) {
      if (col.defaultValue || col.isPrimary) {
        defaults[col.name] = '';
      } else {
        defaults[col.name] = '';
      }
    }
    setNewRow(defaults);
    setAddingRow(true);
  }

  async function commitNewRow() {
    if (!selected) return;
    const payload: Record<string, unknown> = {};
    for (const col of columns) {
      const val = newRow[col.name];
      if (val === undefined || val === '') continue;
      payload[col.name] = val === 'NULL' ? null : val;
    }

    try {
      await api.projects.insertRow(projectId, selected, payload);
      toast.success('Row inserted');
      setAddingRow(false);
      setNewRow({});
      reloadRows();
      loadTables();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDeleteRow(row: Record<string, unknown>) {
    if (!selected) return;
    const pkWhere = getPkWhere(row);
    if (!Object.keys(pkWhere).length) {
      toast.error('Cannot delete: table has no primary key');
      return;
    }
    if (!confirm('Delete this row?')) return;

    try {
      await api.projects.deleteRow(projectId, selected, pkWhere);
      toast.success('Row deleted');
      reloadRows();
      loadTables();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Table Viewer</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={loadTables}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Table
          </Button>
        </div>
      </div>

      {tables.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed">
          <Table2 className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">No tables found</p>
          <p className="mb-4 text-sm text-muted-foreground">
            Create your first table to get started.
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Table
          </Button>
        </div>
      ) : (
        <div className="flex gap-4">
          {/* Table list */}
          <div className="w-52 shrink-0 space-y-1">
            {tables.map((t) => (
              <div key={t.name} className="group relative">
                <button
                  onClick={() => selectTable(t.name)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors pr-9',
                    selected === t.name
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  <span className="flex items-center gap-2 truncate">
                    <Table2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{t.name}</span>
                  </span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 shrink-0">
                    {t.rowCount}
                  </Badge>
                </button>
                <button
                  onClick={() => handleDropTable(t.name)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                  title="Drop table"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          {/* Table data */}
          <div className="flex-1 min-w-0 space-y-3">
            {/* Column badges + Add Row */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-wrap gap-1.5">
                {columns.map((col) => (
                  <div
                    key={col.name}
                    className="flex items-center gap-1 rounded border bg-muted/50 px-2 py-1 text-xs"
                  >
                    {col.isPrimary && <Key className="h-3 w-3 text-amber-500" />}
                    <span className="font-medium">{col.name}</span>
                    <span className="text-muted-foreground">{col.type}</span>
                  </div>
                ))}
              </div>
              {selected && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={startAddRow}
                  disabled={addingRow}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add Row
                </Button>
              )}
            </div>

            {/* Data table */}
            {dataLoading ? (
              <div className="flex h-32 items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              </div>
            ) : (
              <>
                <div className="overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        {data?.fields?.map((f) => (
                          <th
                            key={f.name}
                            className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium"
                          >
                            {f.name}
                            {pkColumns.includes(f.name) && (
                              <Key className="ml-1 inline h-3 w-3 text-amber-500" />
                            )}
                          </th>
                        ))}
                        <th className="w-16 px-2 py-2 text-xs font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {/* New row input */}
                      {addingRow && (
                        <tr className="border-b bg-green-50/50 dark:bg-green-950/20">
                          {data?.fields?.map((f) => {
                            const col = columns.find((c) => c.name === f.name);
                            const hasDefault = !!col?.defaultValue;
                            return (
                              <td key={f.name} className="px-1 py-1">
                                <Input
                                  value={newRow[f.name] ?? ''}
                                  onChange={(e) =>
                                    setNewRow((prev) => ({ ...prev, [f.name]: e.target.value }))
                                  }
                                  placeholder={hasDefault ? `(${col?.defaultValue})` : ''}
                                  className="h-7 text-xs font-mono"
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitNewRow();
                                    if (e.key === 'Escape') {
                                      setAddingRow(false);
                                      setNewRow({});
                                    }
                                  }}
                                />
                              </td>
                            );
                          })}
                          <td className="px-1 py-1">
                            <div className="flex gap-0.5">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-green-600"
                                onClick={commitNewRow}
                              >
                                <Check className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => {
                                  setAddingRow(false);
                                  setNewRow({});
                                }}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}

                      {/* Existing rows */}
                      {data && data.rows.length > 0 ? (
                        data.rows.map((row, rowIdx) => (
                          <tr
                            key={rowIdx}
                            className="group border-b last:border-0 hover:bg-muted/30"
                          >
                            {data.fields?.map((f) => {
                              const isEditing =
                                editingCell?.rowIdx === rowIdx &&
                                editingCell?.field === f.name;
                              const isPk = pkColumns.includes(f.name);

                              if (isEditing) {
                                return (
                                  <td key={f.name} className="px-1 py-0.5">
                                    <Input
                                      ref={editRef}
                                      value={editValue}
                                      onChange={(e) => setEditValue(e.target.value)}
                                      onKeyDown={handleEditKeyDown}
                                      onBlur={commitEdit}
                                      className="h-7 text-xs font-mono"
                                    />
                                  </td>
                                );
                              }

                              return (
                                <td
                                  key={f.name}
                                  className={cn(
                                    'max-w-[200px] truncate whitespace-nowrap px-3 py-1.5 font-mono text-xs',
                                    !isPk && 'cursor-pointer hover:bg-primary/5',
                                    isPk && 'text-muted-foreground',
                                  )}
                                  onDoubleClick={() => startEdit(rowIdx, f.name)}
                                  title={isPk ? 'Primary key (read-only)' : 'Double-click to edit'}
                                >
                                  {row[f.name] === null ? (
                                    <span className="text-muted-foreground/40 italic">NULL</span>
                                  ) : (
                                    String(row[f.name])
                                  )}
                                </td>
                              );
                            })}
                            <td className="px-1 py-0.5 text-right">
                              <div className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-destructive/70 hover:text-destructive"
                                  onClick={() => handleDeleteRow(row)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))
                      ) : !addingRow ? (
                        <tr>
                          <td
                            colSpan={(data?.fields?.length ?? 0) + 1}
                            className="py-8 text-center text-sm text-muted-foreground"
                          >
                            No rows — click &quot;Add Row&quot; to insert data
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {data && data.totalPages > 1 && (
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      {data.total} rows — page {data.page}/{data.totalPages}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={page <= 1}
                        onClick={() => loadPage(page - 1)}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={page >= (data.totalPages || 1)}
                        onClick={() => loadPage(page + 1)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <CreateTableDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={loadTables}
      />
    </div>
  );
}
