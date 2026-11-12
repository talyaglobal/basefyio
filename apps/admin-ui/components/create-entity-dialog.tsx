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
import {
  EntityFieldsEditor,
  FieldsEditorValue,
  initialFieldsValue,
  resolveFields,
} from '@/components/entity-fields-editor';

// ── Create Entity Dialog ────────────────────────────────────

export function CreateEntityDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  onCreated: (logicalName: string) => void;
}) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<FieldsEditorValue>(() => initialFieldsValue([]));
  const [saving, setSaving] = useState(false);

  function reset() {
    setName('');
    setDisplayName('');
    setDescription('');
    setFields(initialFieldsValue([]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { toast.error('Entity name is required'); return; }
    if (!displayName.trim()) { toast.error('Display name is required'); return; }
    let fieldList: unknown[];
    try {
      fieldList = resolveFields(fields);
    } catch (err: any) {
      toast.error(err.message);
      return;
    }
    setSaving(true);
    try {
      const created = await api.projects.createEntityDefinition(projectId, {
        logicalName: name.trim(),
        displayName: displayName.trim(),
        fields: fieldList,
        description: description.trim() || undefined,
      });
      toast.success(`Entity "${displayName}" created`);
      const logicalName = created?.logicalName ?? name.trim();
      reset();
      onOpenChange(false);
      onCreated(logicalName);
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
          <DialogTitle>Create Entity</DialogTitle>
          <DialogDescription>
            An entity stores JSON documents in the Data Engine, served by the
            /api/v1/projects/:id/data/:entity API. Fields you define are checked on every
            write. For schema-free JSON stored in the project database, create a JSON
            collection instead.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="ce-name">Logical name</Label>
            <Input id="ce-name" placeholder="e.g. patients, orders, tasks" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <p className="mt-1 text-[11px] text-muted-foreground">Used in the API path; names that differ only in case or punctuation are not allowed.</p>
          </div>
          <div>
            <Label htmlFor="ce-display">Display name</Label>
            <Input id="ce-display" placeholder="e.g. Patients, Orders, Tasks" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ce-desc">Description (optional)</Label>
            <Input id="ce-desc" placeholder="What this entity stores" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <EntityFieldsEditor value={fields} onChange={setFields} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Creating...' : 'Create'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
