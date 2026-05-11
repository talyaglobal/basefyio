'use client';

import { useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TableInfo, ColumnInfo, TableRows, ForeignKeyInfo } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { CreateTableDialog } from '@/components/create-table-dialog';
import { ImportDataDialog } from '@/components/import-data-dialog';
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
  Columns3,
  Key,
  Link2,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  X,
  Upload as ImportIcon,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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

// ── Column Side Panel ──────────────────────────────────────

function ColumnSidePanel({
  columns,
  tables,
  projectId,
  tableName,
  onClose,
  onUpdated,
  onAddColumn,
}: {
  columns: ColumnInfo[];
  tables: TableInfo[];
  projectId: string;
  tableName: string;
  onClose: () => void;
  onUpdated: () => void;
  onAddColumn: () => void;
}) {
  const [editingCol, setEditingCol] = useState<ColumnInfo | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [nullable, setNullable] = useState(true);
  const [defaultValue, setDefaultValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [fkLoading, setFkLoading] = useState(false);
  const [addFkOpen, setAddFkOpen] = useState(false);

  useEffect(() => {
    api.projects.getForeignKeys(projectId, tableName).then(setForeignKeys).catch(() => setForeignKeys([]));
  }, [projectId, tableName]);

  async function reloadFks() {
    setFkLoading(true);
    try {
      const fks = await api.projects.getForeignKeys(projectId, tableName);
      setForeignKeys(fks);
    } finally {
      setFkLoading(false);
    }
  }

  function startEdit(col: ColumnInfo) {
    setEditingCol(col);
    setName(col.name);
    setType(col.type);
    setNullable(col.nullable);
    setDefaultValue(col.defaultValue ?? '');
    setConfirmDelete(null);
  }

  function cancelEdit() {
    setEditingCol(null);
    setConfirmDelete(null);
  }

  async function saveEdit() {
    if (!editingCol) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (name !== editingCol.name) changes.name = name;
      if (type !== editingCol.type) changes.type = type;
      if (nullable !== editingCol.nullable) changes.nullable = nullable;
      const newDefault = defaultValue || null;
      if (newDefault !== editingCol.defaultValue) changes.defaultValue = newDefault;

      if (Object.keys(changes).length === 0) {
        setEditingCol(null);
        return;
      }

      await api.projects.editColumn(projectId, tableName, editingCol.name, changes);
      toast.success(`Column "${editingCol.name}" updated`);
      setEditingCol(null);
      onUpdated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(colName: string) {
    if (confirmDelete !== colName) {
      setConfirmDelete(colName);
      return;
    }
    setSaving(true);
    try {
      await api.projects.deleteColumn(projectId, tableName, colName);
      toast.success(`Column "${colName}" deleted`);
      if (editingCol?.name === colName) setEditingCol(null);
      setConfirmDelete(null);
      onUpdated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-72 shrink-0 border-l bg-card flex flex-col">
      {/* Panel header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Columns3 className="h-4 w-4" />
          Columns
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onAddColumn} title="Add column">
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Column list or edit form */}
      <div className="flex-1 overflow-y-auto">
        {editingCol ? (
          <div className="p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Editing column</span>
              <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={cancelEdit}>
                Back
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-sm"
                pattern="^[a-zA-Z_][a-zA-Z0-9_]*$"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Type</Label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
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
              <Label className="text-xs">Default Value</Label>
              <Input
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                placeholder="none"
                className="h-8 text-sm"
                list={`edit-col-defaults-${editingCol.name}`}
              />
              {DEFAULT_SUGGESTIONS[type] && (
                <datalist id={`edit-col-defaults-${editingCol.name}`}>
                  {DEFAULT_SUGGESTIONS[type].map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={nullable}
                onChange={(e) => setNullable(e.target.checked)}
                className="rounded"
                disabled={editingCol.isPrimary}
              />
              Nullable
            </label>

            {editingCol.isPrimary && (
              <Badge variant="secondary" className="text-amber-600 text-xs">
                <Key className="mr-1 h-3 w-3" /> Primary Key
              </Badge>
            )}

            <div className="flex flex-col gap-2 pt-2 border-t">
              <Button size="sm" onClick={saveEdit} disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button
                size="sm"
                variant={confirmDelete === editingCol.name ? 'destructive' : 'outline'}
                onClick={() => handleDelete(editingCol.name)}
                disabled={saving}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {confirmDelete === editingCol.name ? 'Confirm Delete' : 'Delete Column'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-1 space-y-0.5">
            {columns.map((col) => (
              <button
                key={col.name}
                onClick={() => startEdit(col)}
                className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {col.isPrimary && <Key className="h-3 w-3 shrink-0 text-amber-500" />}
                    <span className="font-medium truncate">{col.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-xs text-muted-foreground">{col.type}</span>
                    {col.nullable && (
                      <span className="text-[10px] text-blue-500 font-mono">nullable</span>
                    )}
                    {col.defaultValue && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[100px]">
                        = {col.defaultValue}
                      </span>
                    )}
                  </div>
                </div>
                <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors" />
              </button>
            ))}
          </div>
        )}

        {/* Relations (Foreign Keys) */}
        <div className="border-t mt-2 pt-3">
          <div className="flex items-center justify-between px-3 mb-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              Relations
            </div>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAddFkOpen(true)} title="Add foreign key">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="p-1 space-y-1 max-h-32 overflow-y-auto">
            {fkLoading ? (
              <div className="flex justify-center py-4">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : foreignKeys.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No foreign keys</p>
            ) : (
              foreignKeys.map((fk) => (
                <div key={fk.constraintName} className="group flex items-center justify-between rounded-md px-3 py-2 text-xs hover:bg-accent">
                  <span className="truncate">
                    <span className="font-medium">{fk.columnName}</span>
                    <span className="text-muted-foreground"> → </span>
                    <span className="font-mono">{fk.foreignTableName}.{fk.foreignColumnName}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                    onClick={async () => {
                      try {
                        await api.projects.deleteForeignKey(projectId, tableName, fk.constraintName);
                        toast.success('Foreign key removed');
                        reloadFks();
                        onUpdated();
                      } catch (err: any) {
                        toast.error(err.message);
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <AddForeignKeyDialog
        open={addFkOpen}
        onOpenChange={setAddFkOpen}
        projectId={projectId}
        tableName={tableName}
        tables={tables}
        columns={columns}
        onAdded={() => {
          reloadFks();
          onUpdated();
        }}
      />
    </div>
  );
}

// ── Add Foreign Key Dialog ─────────────────────────────────────────────────

function AddForeignKeyDialog({
  open,
  onOpenChange,
  projectId,
  tableName,
  tables,
  columns,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  tableName: string;
  tables: TableInfo[];
  columns: ColumnInfo[];
  onAdded: () => void;
}) {
  const [columnName, setColumnName] = useState('');
  const [foreignTableName, setForeignTableName] = useState('');
  const [foreignColumns, setForeignColumns] = useState<ColumnInfo[]>([]);
  const [foreignColumnName, setForeignColumnName] = useState('');
  const [saving, setSaving] = useState(false);

  function reset() {
    setColumnName('');
    setForeignTableName('');
    setForeignColumns([]);
    setForeignColumnName('');
  }

  useEffect(() => {
    if (foreignTableName && foreignTableName !== tableName) {
      api.projects.columns(projectId, foreignTableName).then(setForeignColumns);
    } else {
      setForeignColumns([]);
      setForeignColumnName('');
    }
  }, [projectId, foreignTableName, tableName]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!columnName || !foreignTableName || !foreignColumnName) {
      toast.error('Column, foreign table, and foreign column are required');
      return;
    }
    setSaving(true);
    try {
      await api.projects.addForeignKey(projectId, tableName, {
        columnName,
        foreignTableName,
        foreignColumnName,
      });
      toast.success('Foreign key added');
      reset();
      onOpenChange(false);
      onAdded();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  const otherTables = tables.filter((t) => t.name !== tableName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Foreign Key</DialogTitle>
          <DialogDescription>
            Add a relation from <span className="font-mono font-semibold">{tableName}</span> to another table.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Column</Label>
            <select
              value={columnName}
              onChange={(e) => setColumnName(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              required
            >
              <option value="">Select column</option>
              {columns.map((c) => (
                <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>References table</Label>
            <select
              value={foreignTableName}
              onChange={(e) => setForeignTableName(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              required
            >
              <option value="">Select table</option>
              {otherTables.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>References column</Label>
            <select
              value={foreignColumnName}
              onChange={(e) => setForeignColumnName(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              required
              disabled={!foreignTableName}
            >
              <option value="">Select column</option>
              {foreignColumns.map((c) => (
                <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Adding...' : 'Add Foreign Key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Table Editor ──────────────────────────────────────

export function TableEditor({ projectId }: TableEditorProps) {
  const [tables, setTables] = useState<TableInfo[]>([]);

  // Look up schema for a given table name from the listTables result so the
  // backend resolves "public.users" vs "auth.users" unambiguously.
  const schemaFor = (name: string | null): string | undefined =>
    name ? tables.find((t) => t.name === name)?.schema : undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [data, setData] = useState<TableRows | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [editingCell, setEditingCell] = useState<{ rowIdx: number; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addingRow, setAddingRow] = useState(false);
  const [newRow, setNewRow] = useState<Record<string, string>>({});
  const editRef = useRef<HTMLInputElement>(null);

  // ── Sidebar resize ────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('kb_table_editor_sidebar_width');
      if (saved) return Math.max(160, Math.min(480, Number(saved)));
    }
    return 224;
  });
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  function handleResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    isResizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;

    function onMouseMove(ev: MouseEvent) {
      if (!isResizing.current) return;
      const delta = ev.clientX - resizeStartX.current;
      const next = Math.max(160, Math.min(480, resizeStartWidth.current + delta));
      setSidebarWidth(next);
    }

    function onMouseUp() {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      setSidebarWidth((w) => {
        localStorage.setItem('kb_table_editor_sidebar_width', String(w));
        return w;
      });
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [columnPanelOpen, setColumnPanelOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('kb_table_editor_column_panel_open') === 'true';
  });

  const [filterText, setFilterText] = useState('');
  const [tableSearch, setTableSearch] = useState('');
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());

  const pkColumns = columns.filter((c) => c.isPrimary).map((c) => c.name);
  const tableSearchLower = tableSearch.trim().toLowerCase();
  const filteredTables =
    tableSearchLower.length === 0
      ? tables
      : tables.filter((t) => t.name.toLowerCase().includes(tableSearchLower));

  useEffect(() => {
    loadTables();
  }, [projectId]);

  useEffect(() => {
    if (editRef.current) editRef.current.focus();
  }, [editingCell]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('kb_table_editor_column_panel_open', columnPanelOpen ? 'true' : 'false');
  }, [columnPanelOpen]);

  async function loadTables() {
    setLoading(true);
    try {
      const result = await api.projects.tables(projectId);
      setTables(result);
      setOpenTabs((prev) => prev.filter((name) => result.some((t) => t.name === name)));
      if (result.length > 0) {
        const target =
          selected && result.some((t) => t.name === selected)
            ? selected
            : result[0].name;
        openTable(target);
      } else {
        setSelected(null);
        setOpenTabs([]);
        setColumns([]);
        setData(null);
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openTable(name: string) {
    setOpenTabs((prev) => (prev.includes(name) ? prev : [...prev, name]));
    selectTable(name);
  }

  function closeTab(name: string) {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t !== name);
      if (selected === name) {
        const fallback = next[next.length - 1] ?? null;
        if (fallback) {
          selectTable(fallback);
        } else {
          setSelected(null);
          setColumns([]);
          setData(null);
          setEditingCell(null);
          setAddingRow(false);
          setSelectedRows(new Set());
        }
      }
      return next;
    });
  }

  async function selectTable(name: string) {
    setSelected(name);
    setPage(1);
    setEditingCell(null);
    setAddingRow(false);
    setFilterText('');
    setSelectedRows(new Set());
    setDataLoading(true);

    try {
      const [cols, rows] = await Promise.all([
        api.projects.columns(projectId, name, schemaFor(name)),
        api.projects.rows(projectId, name, 1, 50, schemaFor(name)),
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
        api.projects.columns(projectId, selected, schemaFor(selected)),
        api.projects.rows(projectId, selected, page, 50, schemaFor(selected)),
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
      const rows = await api.projects.rows(projectId, selected, page, 50, schemaFor(selected));
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
    setSelectedRows(new Set());
    setDataLoading(true);
    try {
      const rows = await api.projects.rows(projectId, selected, p, 50, schemaFor(selected));
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
      setOpenTabs((prev) => prev.filter((t) => t !== name));
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
      }, schemaFor(selected));
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
      await api.projects.insertRow(projectId, selected, payload, schemaFor(selected));
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
      await api.projects.deleteRow(projectId, selected, pkWhere, schemaFor(selected));
      toast.success('Row deleted');
      reloadRows();
      loadTables();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function toggleRowSelect(idx: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }

  function toggleSelectAllRows() {
    if (!filteredRows) return;
    if (selectedRows.size === filteredRows.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(filteredRows.map((_, i) => i)));
    }
  }

  async function handleDeleteSelectedRows() {
    if (!selected || !filteredRows || selectedRows.size === 0) return;
    if (pkColumns.length === 0) {
      toast.error('Cannot delete: table has no primary key');
      return;
    }
    if (!confirm(`Delete ${selectedRows.size} row(s)?`)) return;

    let deleted = 0;
    for (const idx of Array.from(selectedRows)) {
      const row = filteredRows[idx];
      if (!row) continue;
      try {
        await api.projects.deleteRow(projectId, selected, getPkWhere(row), schemaFor(selected));
        deleted++;
      } catch {}
    }

    toast.success(`Deleted ${deleted} row(s)`);
    setSelectedRows(new Set());
    reloadRows();
    loadTables();
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
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <ImportIcon className="mr-2 h-4 w-4" />
            Import Data
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
        <div
          className="flex h-[calc(100vh-220px)] min-h-[480px] max-h-[calc(100vh-220px)] gap-0 overflow-hidden rounded-lg border"
        >
          {/* Sidebar: table list */}
          <div
            className="shrink-0 border-r bg-muted/30 flex flex-col relative"
            style={{ width: sidebarWidth }}
          >
            <div className="sticky top-0 z-10 shrink-0 border-b bg-muted/40 p-2 backdrop-blur-sm">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  placeholder="Search tables by name…"
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                  className="h-9 bg-background pl-8 pr-8 text-sm shadow-sm"
                  aria-label="Search tables by name"
                />
                {tableSearch.trim().length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTableSearch('')}
                    className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Clear table search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
              {filteredTables.length === 0 && tableSearchLower.length > 0 ? (
                <div className="px-3 py-6">
                  <p className="text-xs text-muted-foreground">
                    No tables match &quot;{tableSearch}&quot;.
                  </p>
                </div>
              ) : (
                filteredTables.map((t) => (
                  <div key={t.name} className="group relative">
                    <button
                      onClick={() => {
                        openTable(t.name);
                      }}
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-1 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent"
                          title="Table options"
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem
                          onClick={() => {
                            openTable(t.name);
                            setColumnPanelOpen(true);
                          }}
                        >
                          <Pencil className="mr-2 h-3.5 w-3.5" />
                          Edit table
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => handleDropTable(t.name)}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Delete table
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))
              )}
            </div>

            {/* Drag handle */}
            <div
              onMouseDown={handleResizeMouseDown}
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40 transition-colors z-10"
              title="Drag to resize"
            />
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0 flex flex-col">
            {selected ? (
              <>
                <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1.5 overflow-x-auto">
                  {openTabs.map((tab) => {
                    const active = tab === selected;
                    return (
                      <div
                        key={tab}
                        onClick={() => selectTable(tab)}
                        className={cn(
                          'inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors',
                          active
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-transparent bg-background/70 text-muted-foreground hover:bg-accent',
                        )}
                      >
                        <span className="max-w-[140px] truncate">{tab}</span>
                        <button
                          type="button"
                          aria-label={`Close ${tab}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(tab);
                          }}
                          className="rounded p-0.5 hover:bg-muted"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>

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

                {/* Data area + optional column panel */}
                <div className="flex-1 flex min-h-0">
                  {/* Table */}
                  <div className="flex-1 min-w-0 flex flex-col">
                    {dataLoading ? (
                      <div className="flex flex-1 items-center justify-center">
                        <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                      </div>
                    ) : (
                      <div className="flex-1 overflow-auto relative">
                        {/* Bulk action bar */}
                        {selectedRows.size > 0 && (
                          <div className="sticky top-0 z-20 flex items-center gap-3 border-b bg-primary/10 px-4 py-2">
                            <span className="text-sm font-medium">{selectedRows.size} row(s) selected</span>
                            <Button size="sm" variant="destructive" onClick={handleDeleteSelectedRows}>
                              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                              Delete selected
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setSelectedRows(new Set())}>
                              Clear
                            </Button>
                          </div>
                        )}
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 z-10" style={selectedRows.size > 0 ? { top: 41 } : undefined}>
                            <tr className="border-b bg-muted/50">
                              <th className="sticky left-0 z-[11] w-10 bg-muted/50 px-2 py-2 text-center">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded"
                                  checked={!!filteredRows && filteredRows.length > 0 && selectedRows.size === filteredRows.length}
                                  onChange={toggleSelectAllRows}
                                />
                              </th>
                              <th className="w-10 px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                                #
                              </th>
                              {data?.fields?.map((f) => {
                                const col = columns.find((c) => c.name === f.name);
                                return (
                                  <th
                                    key={f.name}
                                    className="group/th whitespace-nowrap px-3 py-2 text-left text-xs font-medium"
                                  >
                                    <span className="flex items-center gap-1">
                                      {pkColumns.includes(f.name) && (
                                        <Key className="h-3 w-3 text-amber-500" />
                                      )}
                                      {f.name}
                                      <span className="text-[10px] text-muted-foreground font-normal ml-1">
                                        {col?.type}
                                      </span>
                                      <button
                                        onClick={() => setColumnPanelOpen(true)}
                                        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded opacity-0 group-hover/th:opacity-100 transition-opacity hover:bg-accent"
                                        title={`Edit columns`}
                                      >
                                        <Pencil className="h-3 w-3 text-muted-foreground" />
                                      </button>
                                    </span>
                                  </th>
                                );
                              })}
                              <th className="sticky right-0 z-[11] w-10 bg-muted/50 px-2 py-2 text-xs font-medium" />
                            </tr>
                          </thead>
                          <tbody>
                            {/* New row input */}
                            {addingRow && (
                              <tr className="border-b bg-green-50/50 dark:bg-green-950/20">
                                <td className="sticky left-0 bg-green-50/50 dark:bg-green-950/20 px-2 py-1" />
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
                                <td className="sticky right-0 bg-green-50/50 dark:bg-green-950/20 px-1 py-1">
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
                                const isRowSelected = selectedRows.has(rowIdx);
                                return (
                                  <tr
                                    key={rowIdx}
                                    className={cn(
                                      'group border-b last:border-0',
                                      isRowSelected ? 'bg-primary/5' : 'hover:bg-muted/30',
                                    )}
                                  >
                                    <td className={cn(
                                      'sticky left-0 z-[1] px-2 py-1.5 text-center',
                                      isRowSelected ? 'bg-primary/5' : 'bg-card group-hover:bg-muted/30',
                                    )}>
                                      <input
                                        type="checkbox"
                                        className="h-3.5 w-3.5 rounded"
                                        checked={isRowSelected}
                                        onChange={() => toggleRowSelect(rowIdx)}
                                      />
                                    </td>
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
                                    <td className={cn(
                                      'sticky right-0 z-[1] px-1 py-0.5 text-right',
                                      isRowSelected ? 'bg-primary/5' : 'bg-card group-hover:bg-muted/30',
                                    )}>
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
                                  colSpan={(data?.fields?.length ?? 0) + 3}
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
                  </div>

                  {/* Column side panel */}
                  {columnPanelOpen && selected && (
                    <ColumnSidePanel
                      columns={columns}
                      tables={tables}
                      projectId={projectId}
                      tableName={selected}
                      onClose={() => setColumnPanelOpen(false)}
                      onUpdated={reloadTableData}
                      onAddColumn={() => setAddColumnOpen(true)}
                    />
                  )}
                </div>
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
        onCreated={(createdTableName) => {
          loadTables();
          if (createdTableName) {
            setTimeout(() => openTable(createdTableName), 0);
          }
        }}
      />
      <ImportDataDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={projectId}
        tables={tables}
        defaultTargetTable={selected}
        onCompleted={() => {
          loadTables();
          if (selected) reloadTableData();
        }}
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
    </div>
  );
}
