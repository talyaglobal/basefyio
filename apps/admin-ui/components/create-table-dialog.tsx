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
import { Plus, Trash2, Key, Braces, Table2 } from 'lucide-react';
import { FieldTypeSelector } from '@/components/field-type-selector';
import { DEFAULT_SUGGESTIONS } from '@/lib/pg-field-types';

interface ColumnDef {
  id: number;
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  defaultValue: string;
}

/** What the unified dialog created: a SQL table or a NoSQL collection. */
export type CreatedDataObject = { kind: 'sql' | 'nosql'; name: string };

interface CreateTableDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  onCreated: (created?: CreatedDataObject) => void;
}

let nextId = 1;
function makeColumn(): ColumnDef {
  return { id: nextId++, name: '', type: 'text', nullable: true, isPrimary: false, defaultValue: '' };
}

function makeIdColumn(): ColumnDef {
  return { id: nextId++, name: 'id', type: 'uuid', nullable: false, isPrimary: true, defaultValue: 'gen_random_uuid()' };
}

export function CreateTableDialog({ open, onOpenChange, projectId, onCreated }: CreateTableDialogProps) {
  const [kind, setKind] = useState<'sql' | 'nosql'>('sql');
  const [tableName, setTableName] = useState('');
  const [collectionName, setCollectionName] = useState('');
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
    setKind('sql');
    setTableName('');
    setCollectionName('');
    setColumns([makeIdColumn(), { ...makeColumn(), name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()' }]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (kind === 'nosql') {
      await handleCreateCollection();
      return;
    }

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
      const created: CreatedDataObject = { kind: 'sql', name: tableName.trim() };
      reset();
      onOpenChange(false);
      onCreated(created);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateCollection() {
    const trimmed = collectionName.trim();
    if (!trimmed) {
      toast.error('Collection name is required');
      return;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
      toast.error('Collection name must start with a letter or underscore and contain only alphanumeric characters');
      return;
    }
    setSaving(true);
    try {
      await api.projects.createCollection(projectId, trimmed);
      toast.success(`Collection "${trimmed}" created`);
      reset();
      onOpenChange(false);
      onCreated({ kind: 'nosql', name: trimmed });
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
          <DialogTitle>Create New</DialogTitle>
          <DialogDescription>
            {kind === 'sql'
              ? 'A SQL table with typed columns, constraints, and defaults.'
              : 'A NoSQL collection of schema-flexible JSON documents.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Data type">
          <button
            type="button"
            role="radio"
            aria-checked={kind === 'sql'}
            onClick={() => setKind('sql')}
            className={`flex items-center gap-2.5 rounded-lg border-2 p-2.5 text-left transition-all ${
              kind === 'sql'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/40 hover:bg-muted/50'
            }`}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400">
              <Table2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold">SQL Table</p>
              <p className="text-[11px] text-muted-foreground truncate">Structured columns & types</p>
            </div>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={kind === 'nosql'}
            onClick={() => setKind('nosql')}
            className={`flex items-center gap-2.5 rounded-lg border-2 p-2.5 text-left transition-all ${
              kind === 'nosql'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/40 hover:bg-muted/50'
            }`}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400">
              <Braces className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold">NoSQL Collection</p>
              <p className="text-[11px] text-muted-foreground truncate">Schema-flexible JSON documents</p>
            </div>
          </button>
        </div>

        {kind === 'sql' ? (
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
                    className="grid grid-cols-[1fr_140px_44px_44px_140px_36px] items-center gap-2 rounded-md border bg-card p-1.5 transition-colors duration-200 hover:bg-accent/55 dark:hover:bg-accent/30"
                  >
                    <Input
                      value={col.name}
                      onChange={(e) => updateColumn(col.id, 'name', e.target.value)}
                      placeholder="column_name"
                      className="h-8 text-sm"
                    />

                    <FieldTypeSelector
                      value={col.type}
                      onValueChange={(v) => updateColumn(col.id, 'type', v)}
                      compact
                    />

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
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cc-name">Collection Name</Label>
              <Input
                id="cc-name"
                value={collectionName}
                onChange={(e) => setCollectionName(e.target.value)}
                placeholder="e.g. posts, products, events"
                required
                pattern="^[a-zA-Z_][a-zA-Z0-9_]*$"
              />
              <p className="text-xs text-muted-foreground">
                No columns to define — documents can have any JSON structure.
                You can insert documents right after creating the collection.
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Creating...' : 'Create Collection'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
