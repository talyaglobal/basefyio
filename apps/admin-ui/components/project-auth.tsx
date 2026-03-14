'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { RealmInfo, RealmUser } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
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
import { Plus, RefreshCw, Shield, Trash2, Users } from 'lucide-react';

interface ProjectAuthProps {
  projectId: string;
}

export function ProjectAuth({ projectId }: ProjectAuthProps) {
  const [realm, setRealm] = useState<RealmInfo | null>(null);
  const [users, setUsers] = useState<RealmUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    loadAll();
  }, [projectId]);

  async function loadAll() {
    setLoading(true);
    try {
      const [r, u] = await Promise.all([
        api.projects.realmInfo(projectId),
        api.projects.realmUsers(projectId),
      ]);
      setRealm(r);
      setUsers(u);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(userId: string, email: string) {
    if (!confirm(`Delete user "${email}"?`)) return;
    try {
      await api.projects.deleteRealmUser(projectId, userId);
      toast.success(`User deleted`);
      loadAll();
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Authentication</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={loadAll}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add User
          </Button>
        </div>
      </div>

      {/* Realm stats */}
      {realm && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Shield className="h-4 w-4" />
              Realm
            </div>
            <p className="mt-1 text-lg font-semibold">{realm.name}</p>
            <Badge variant={realm.enabled ? 'default' : 'secondary'} className="mt-1">
              {realm.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              Users
            </div>
            <p className="mt-1 text-3xl font-bold">{realm.userCount}</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <div className="text-sm text-muted-foreground">Settings</div>
            <div className="mt-2 space-y-1 text-sm">
              <p>Registration: {realm.registrationAllowed ? 'On' : 'Off'}</p>
              <p>Email login: {realm.loginWithEmailAllowed ? 'On' : 'Off'}</p>
            </div>
          </div>
        </div>
      )}

      {/* User list */}
      {users.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed">
          <Users className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">No users yet</p>
          <p className="text-sm text-muted-foreground">
            Add users to this project&apos;s authentication realm.
          </p>
        </div>
      ) : (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">Email</th>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{u.email}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={u.enabled ? 'default' : 'secondary'}>
                      {u.enabled ? 'Active' : 'Disabled'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => handleDelete(u.id, u.email)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateUserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        onCreated={loadAll}
      />
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
  });
  const [saving, setSaving] = useState(false);

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.projects.createRealmUser(projectId, form);
      toast.success(`User created`);
      setForm({ email: '', password: '', firstName: '', lastName: '' });
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create User</DialogTitle>
          <DialogDescription>
            Add a new user to this project&apos;s Keycloak realm.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cu-first">First Name</Label>
              <Input id="cu-first" value={form.firstName} onChange={(e) => update('firstName', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cu-last">Last Name</Label>
              <Input id="cu-last" value={form.lastName} onChange={(e) => update('lastName', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-email">Email *</Label>
            <Input id="cu-email" type="email" value={form.email} onChange={(e) => update('email', e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-pass">Password *</Label>
            <Input id="cu-pass" type="password" value={form.password} onChange={(e) => update('password', e.target.value)} required minLength={6} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Creating...' : 'Create User'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
