'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Trash2, Key, GripVertical } from 'lucide-react';

const PG_TYPES = [
  { value: 'uuid', label: 'UUID' },
  { value: 'serial', label: 'Serial (auto-increment)' },
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

interface ColumnDef {
  id: number;
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  defaultValue: string;
}

interface CreateTableDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  onCreated: () => void;
}

let nextId = 1;
function makeColumn(): ColumnDef {
  return { id: nextId++, name: '', type: 'text', nullable: true, isPrimary: false, defaultValue: '' };
}

function makeIdColumn(): ColumnDef {
  return { id: nextId++, name: 'id', type: 'uuid', nullable: false, isPrimary: true, defaultValue: 'gen_random_uuid()' };
}

export function CreateTableDialog({ open, onOpenChange, projectId, onCreated }: CreateTableDialogProps) {
  const [tableName, setTableName] = useState('');
  const [columns, setColumns] = useState<ColumnDef[]>([makeIdColumn(), { ...makeColumn(), name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()' }]);
  const [saving, setSaving] = useState(false);

  function addColumn() {
    setColumns((prev) => [...prev, makeColumn()]);
  }

  function removeColumn(id: number) {
    setColumns((prev) => prev.filter((c) => c.id !== id));
  }

  function updateColumn(id: number, field: keyof ColumnDef, value: any) {
    setColumns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
    );
  }

  function reset() {
    setTableName('');
    setColumns([makeIdColumn(), { ...makeColumn(), name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()' }]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!tableName.trim()) {
      toast.error('Table name is required');
      return;
    }

    const validCols = columns.filter((c) => c.name.trim());
    if (validCols.length === 0) {
      toast.error('At least one column is required');
      return;
    }

    setSaving(true);
    try {
      const result = await api.projects.createTable(projectId, {
        name: tableName.trim(),
        columns: validCols.map((c) => ({
          name: c.name.trim(),
          type: c.type,
          nullable: c.nullable,
          isPrimary: c.isPrimary,
          defaultValue: c.defaultValue || undefined,
        })),
      });
      toast.success(result.message);
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Table</DialogTitle>
          <DialogDescription>
            Define columns with types, constraints, and defaults.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ct-name">Table Name</Label>
            <Input
              id="ct-name"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder="users"
              required
              pattern="^[a-zA-Z_][a-zA-Z0-9_]*$"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Columns</Label>
              <Button type="button" variant="outline" size="sm" onClick={addColumn}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add Column
              </Button>
            </div>

            {/* Column header */}
            <div className="grid grid-cols-[1fr_140px_44px_44px_140px_36px] gap-2 px-1 text-[11px] font-medium text-muted-foreground">
              <span>Name</span>
              <span>Type</span>
              <span className="text-center">PK</span>
              <span className="text-center">Null</span>
              <span>Default</span>
              <span />
            </div>

            <div className="space-y-1.5">
              {columns.map((col) => (
                <div
                  key={col.id}
                  className="grid grid-cols-[1fr_140px_44px_44px_140px_36px] items-center gap-2 rounded-md border bg-card p-1.5"
                >
                  <Input
                    value={col.name}
                    onChange={(e) => updateColumn(col.id, 'name', e.target.value)}
                    placeholder="column_name"
                    className="h-8 text-sm"
                  />

                  <select
                    value={col.type}
                    onChange={(e) => updateColumn(col.id, 'type', e.target.value)}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    {PG_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => updateColumn(col.id, 'isPrimary', !col.isPrimary)}
                    className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors mx-auto ${
                      col.isPrimary
                        ? 'border-amber-400 bg-amber-50 text-amber-600'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                    title="Primary Key"
                  >
                    <Key className="h-3.5 w-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => updateColumn(col.id, 'nullable', !col.nullable)}
                    className={`flex h-8 w-8 items-center justify-center rounded-md border text-xs font-mono transition-colors mx-auto ${
                      col.nullable
                        ? 'border-blue-300 bg-blue-50 text-blue-600'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                    title="Nullable"
                  >
                    {col.nullable ? '?' : '!'}
                  </button>

                  <div className="relative">
                    <Input
                      value={col.defaultValue}
                      onChange={(e) => updateColumn(col.id, 'defaultValue', e.target.value)}
                      placeholder="default"
                      className="h-8 text-xs"
                      list={`defaults-${col.id}`}
                    />
                    {DEFAULT_SUGGESTIONS[col.type] && (
                      <datalist id={`defaults-${col.id}`}>
                        {DEFAULT_SUGGESTIONS[col.type].map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    )}
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive/70 hover:text-destructive"
                    onClick={() => removeColumn(col.id)}
                    disabled={columns.length <= 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Creating...' : 'Create Table'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
