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
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { toast.error('Entity name is required'); return; }
    if (!displayName.trim()) { toast.error('Display name is required'); return; }
    setSaving(true);
    try {
      const created = await api.projects.createEntityDefinition(projectId, {
        logicalName: name.trim(),
        displayName: displayName.trim(),
        fields: [],
        description: description.trim() || undefined,
      });
      toast.success(`Entity "${displayName}" created`);
      const logicalName = created?.logicalName ?? name.trim();
      setName(''); setDisplayName(''); setDescription('');
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Entity</DialogTitle>
          <DialogDescription>Define a new entity type for your application data.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Logical name</Label>
            <Input placeholder="e.g. patients, orders, tasks" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <Label>Display name</Label>
            <Input placeholder="e.g. Patients, Orders, Tasks" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input placeholder="What this entity stores" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Creating...' : 'Create'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
