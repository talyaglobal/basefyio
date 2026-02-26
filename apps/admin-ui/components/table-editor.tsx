'use client';

import { useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TableInfo, ColumnInfo, TableRows } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { CreateTableDialog } from '@/components/create-table-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

const PG_TYPES = [
  { value: 'uuid', label: 'UUID' },
  { value: 'serial', label: 'Serial' },
  { value: 'bigserial', label: 'Big Serial' },
  { value: 'integer', label: 'Integer' },
  { value: 'bigint', label: 'Big Integer' },
  { value: 'smallint', label: 'Small Integer' },
  { value: 'text', label: 'Text' },
  { value: 'varchar(255)', label: 'Varchar(255)' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'timestamptz', label: 'Timestamp (TZ)' },
  { value: 'timestamp', label: 'Timestamp' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'numeric', label: 'Numeric' },
  { value: 'real', label: 'Float' },
  { value: 'double precision', label: 'Double' },
  { value: 'jsonb', label: 'JSONB' },
  { value: 'json', label: 'JSON' },
  { value: 'bytea', label: 'Binary' },
];

const DEFAULT_SUGGESTIONS: Record<string, string[]> = {
  uuid: ['gen_random_uuid()'],
  timestamptz: ['now()', 'CURRENT_TIMESTAMP'],
  timestamp: ['now()', 'CURRENT_TIMESTAMP'],
  boolean: ['true', 'false'],
};

interface TableEditorProps {
  projectId: string;
}

// ── Add Column Dialog ──────────────────────────────────────

function AddColumnDialog({
  open,
  onOpenChange,
  projectId,
  tableName,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  tableName: string;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const [nullable, setNullable] = useState(true);
  const [defaultValue, setDefaultValue] = useState('');
  const [isUnique, setIsUnique] = useState(false);
  const [saving, setSaving] = useState(false);

  function reset() {
    setName('');
    setType('text');
    setNullable(true);
    setDefaultValue('');
    setIsUnique(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Column name is required');
      return;
    }
    setSaving(true);
    try {
      await api.projects.addColumn(projectId, tableName, {
        name: name.trim(),
        type,
        nullable,
        defaultValue: defaultValue || undefined,
        isUnique,
      });
      toast.success(`Column "${name}" added`);
      reset();
      onOpenChange(false);
      onAdded();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Column</DialogTitle>
          <DialogDescription>
            Add a new column to <span className="font-mono font-semibold">{tableName}</span>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="column_name"
              pattern="^[a-zA-Z_][a-zA-Z0-9_]*$"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {PG_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Default Value</Label>
            <Input
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              placeholder="optional"
              list="add-col-defaults"
            />
            {DEFAULT_SUGGESTIONS[type] && (
              <datalist id="add-col-defaults">
                {DEFAULT_SUGGESTIONS[type].map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={nullable}
                onChange={(e) => setNullable(e.target.checked)}
                className="rounded"
              />
              Nullable
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isUnique}
                onChange={(e) => setIsUnique(e.target.checked)}
                className="rounded"
              />
              Unique
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Adding...' : 'Add Column'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Column Dialog ─────────────────────────────────────

function EditColumnDialog({
  open,
  onOpenChange,
  projectId,
  tableName,
  column,
  onUpdated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  tableName: string;
  column: ColumnInfo;
  onUpdated: () => void;
}) {
  const [name, setName] = useState(column.name);
  const [type, setType] = useState(column.type);
  const [nullable, setNullable] = useState(column.nullable);
  const [defaultValue, setDefaultValue] = useState(column.defaultValue ?? '');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(column.name);
    setType(column.type);
    setNullable(column.nullable);
    setDefaultValue(column.defaultValue ?? '');
    setConfirmDelete(false);
  }, [column, open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (name !== column.name) changes.name = name;
      if (type !== column.type) changes.type = type;
      if (nullable !== column.nullable) changes.nullable = nullable;
      const newDefault = defaultValue || null;
      if (newDefault !== column.defaultValue) changes.defaultValue = newDefault;

      if (Object.keys(changes).length === 0) {
        onOpenChange(false);
        return;
      }

      await api.projects.editColumn(projectId, tableName, column.name, changes);
      toast.success(`Column "${column.name}" updated`);
      onOpenChange(false);
      onUpdated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    try {
      await api.projects.deleteColumn(projectId, tableName, column.name);
      toast.success(`Column "${column.name}" deleted`);
      onOpenChange(false);
      onUpdated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
      setConfirmDelete(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Column</DialogTitle>
          <DialogDescription>
            Modify <span className="font-mono font-semibold">{column.name}</span> on{' '}
            <span className="font-mono font-semibold">{tableName}</span>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="column_name"
              pattern="^[a-zA-Z_][a-zA-Z0-9_]*$"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {PG_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
              {!PG_TYPES.some((t) => t.value === type) && (
                <option value={type}>{type}</option>
              )}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Default Value</Label>
            <Input
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              placeholder="none"
              list="edit-col-defaults"
            />
            {DEFAULT_SUGGESTIONS[type] && (
              <datalist id="edit-col-defaults">
                {DEFAULT_SUGGESTIONS[type].map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={nullable}
                onChange={(e) => setNullable(e.target.checked)}
                className="rounded"
                disabled={column.isPrimary}
              />
              Nullable
            </label>
            {column.isPrimary && (
              <Badge variant="secondary" className="text-amber-600">
                <Key className="mr-1 h-3 w-3" /> Primary Key
              </Badge>
            )}
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <Button
              type="button"
              variant={confirmDelete ? 'destructive' : 'outline'}
              size="sm"
              onClick={handleDelete}
              disabled={saving}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {confirmDelete ? 'Confirm Delete' : 'Delete Column'}
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Table Editor ──────────────────────────────────────

export function TableEditor({ projectId }: TableEditorProps) {
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

  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [editColumnOpen, setEditColumnOpen] = useState(false);
  const [editingColumn, setEditingColumn] = useState<ColumnInfo | null>(null);

  const [filterText, setFilterText] = useState('');

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
    setFilterText('');
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

  async function reloadTableData() {
    if (!selected) return;
    setDataLoading(true);
    try {
      const [cols, rows] = await Promise.all([
        api.projects.columns(projectId, selected),
        api.projects.rows(projectId, selected, page),
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
    if (!confirm(`Drop table "${name}"? This will delete all data permanently.`)) return;
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
      defaults[col.name] = '';
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

  function openEditColumn(col: ColumnInfo) {
    setEditingColumn(col);
    setEditColumnOpen(true);
  }

  const filteredRows = data?.rows?.filter((row) => {
    if (!filterText) return true;
    const lower = filterText.toLowerCase();
    return Object.values(row).some((v) =>
      v !== null && String(v).toLowerCase().includes(lower),
    );
  });

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Table Editor</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={loadTables}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Table
          </Button>
        </div>
      </div>

      {tables.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed">
          <Table2 className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">No tables yet</p>
          <p className="mb-4 text-sm text-muted-foreground">
            Create your first table to get started.
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Table
          </Button>
        </div>
      ) : (
        <div className="flex gap-0 rounded-lg border overflow-hidden" style={{ minHeight: 480 }}>
          {/* Sidebar: table list */}
          <div className="w-56 shrink-0 border-r bg-muted/30 flex flex-col">
            <div className="p-2 border-b">
              <Input
                placeholder="Search tables..."
                className="h-8 text-xs"
                value={filterText}
                onChange={() => {}}
                onFocus={() => {}}
              />
            </div>
            <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
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
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0 flex flex-col">
            {selected ? (
              <>
                {/* Toolbar */}
                <div className="flex items-center justify-between gap-3 border-b px-4 py-2 bg-card">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-sm font-semibold truncate">{selected}</span>
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {data?.total ?? 0} rows
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Input
                      placeholder="Filter rows..."
                      className="h-8 w-48 text-xs"
                      value={filterText}
                      onChange={(e) => setFilterText(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAddColumnOpen(true)}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      Column
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={startAddRow}
                      disabled={addingRow}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      Row
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={reloadTableData}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Column chips */}
                <div className="flex flex-wrap gap-1.5 border-b px-4 py-2 bg-muted/20">
                  {columns.map((col) => (
                    <button
                      key={col.name}
                      onClick={() => openEditColumn(col)}
                      className="group/chip flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
                      title={`Click to edit "${col.name}"`}
                    >
                      {col.isPrimary && <Key className="h-3 w-3 text-amber-500" />}
                      <span className="font-medium">{col.name}</span>
                      <span className="text-muted-foreground">{col.type}</span>
                      {col.nullable && (
                        <span className="text-blue-500 font-mono text-[10px]">?</span>
                      )}
                      <Pencil className="h-2.5 w-2.5 text-muted-foreground/0 group-hover/chip:text-muted-foreground transition-colors" />
                    </button>
                  ))}
                </div>

                {/* Data table */}
                {dataLoading ? (
                  <div className="flex flex-1 items-center justify-center">
                    <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                  </div>
                ) : (
                  <div className="flex-1 overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-10">
                        <tr className="border-b bg-muted/50">
                          <th className="w-10 px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                            #
                          </th>
                          {data?.fields?.map((f) => (
                            <th
                              key={f.name}
                              className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium cursor-pointer hover:bg-muted/80 transition-colors"
                              onClick={() => {
                                const col = columns.find((c) => c.name === f.name);
                                if (col) openEditColumn(col);
                              }}
                            >
                              <span className="flex items-center gap-1">
                                {pkColumns.includes(f.name) && (
                                  <Key className="h-3 w-3 text-amber-500" />
                                )}
                                {f.name}
                              </span>
                            </th>
                          ))}
                          <th className="w-12 px-2 py-2 text-xs font-medium" />
                        </tr>
                      </thead>
                      <tbody>
                        {/* New row input */}
                        {addingRow && (
                          <tr className="border-b bg-green-50/50 dark:bg-green-950/20">
                            <td className="px-2 py-1 text-center">
                              <span className="text-xs text-green-600 font-medium">NEW</span>
                            </td>
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
                                    placeholder={hasDefault ? `(${col?.defaultValue})` : col?.nullable ? 'NULL' : ''}
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
                        {filteredRows && filteredRows.length > 0 ? (
                          filteredRows.map((row, rowIdx) => {
                            const actualIdx = data!.rows.indexOf(row);
                            return (
                              <tr
                                key={rowIdx}
                                className="group border-b last:border-0 hover:bg-muted/30"
                              >
                                <td className="px-2 py-1.5 text-center text-xs text-muted-foreground tabular-nums">
                                  {(page - 1) * (data?.limit ?? 50) + actualIdx + 1}
                                </td>
                                {data?.fields?.map((f) => {
                                  const isEditing =
                                    editingCell?.rowIdx === actualIdx &&
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
                                        'max-w-[250px] truncate whitespace-nowrap px-3 py-1.5 font-mono text-xs',
                                        !isPk && 'cursor-pointer hover:bg-primary/5',
                                        isPk && 'text-muted-foreground',
                                      )}
                                      onDoubleClick={() => startEdit(actualIdx, f.name)}
                                      title={isPk ? 'Primary key (read-only)' : 'Double-click to edit'}
                                    >
                                      {row[f.name] === null ? (
                                        <span className="text-muted-foreground/40 italic">NULL</span>
                                      ) : typeof row[f.name] === 'boolean' ? (
                                        <Badge variant={row[f.name] ? 'default' : 'secondary'} className="text-[10px]">
                                          {String(row[f.name])}
                                        </Badge>
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
                            );
                          })
                        ) : !addingRow ? (
                          <tr>
                            <td
                              colSpan={(data?.fields?.length ?? 0) + 2}
                              className="py-12 text-center text-sm text-muted-foreground"
                            >
                              {filterText
                                ? 'No rows match your filter'
                                : 'No rows — click "Row" to insert data'}
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination */}
                {data && data.totalPages > 1 && (
                  <div className="flex items-center justify-between border-t px-4 py-2 text-sm text-muted-foreground bg-card">
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
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                Select a table from the sidebar
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dialogs */}
      <CreateTableDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={loadTables}
      />

      {selected && (
        <AddColumnDialog
          open={addColumnOpen}
          onOpenChange={setAddColumnOpen}
          projectId={projectId}
          tableName={selected}
          onAdded={reloadTableData}
        />
      )}

      {selected && editingColumn && (
        <EditColumnDialog
          open={editColumnOpen}
          onOpenChange={setEditColumnOpen}
          projectId={projectId}
          tableName={selected}
          column={editingColumn}
          onUpdated={reloadTableData}
        />
      )}
    </div>
  );
}
