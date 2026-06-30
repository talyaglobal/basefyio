'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { Project } from '@basefyio/sdk';
import { getSdk } from '@/lib/sdk';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface CreateProjectDialogProps {
  onCreated: (project: Project) => void;
  children: React.ReactNode;
}

export function CreateProjectDialog({ onCreated, children }: CreateProjectDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !teamId.trim()) return;
    setLoading(true);
    try {
      const project = await getSdk().projects.create({ name: name.trim(), teamId: teamId.trim() });
      toast.success(`Project "${project.name}" created`);
      onCreated(project);
      setOpen(false);
      setName('');
      setTeamId('');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="proj-name">Name</Label>
            <Input
              id="proj-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proj-team">Team ID</Label>
            <Input
              id="proj-team"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !name.trim() || !teamId.trim()}>
              {loading ? 'Creating...' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
