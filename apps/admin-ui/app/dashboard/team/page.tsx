'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TeamMember, TeamInvite, PendingInvite } from '@/lib/types';
import { useActiveTeam } from '../layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Check,
  Clock,
  Crown,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  X,
} from 'lucide-react';

export default function TeamSettingsPage() {
  const router = useRouter();
  const { activeTeamId, setActiveTeamId } = useActiveTeam();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [myInvites, setMyInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function loadAll() {
    if (!activeTeamId) return;
    setLoading(true);
    try {
      const [m, pi, mi] = await Promise.all([
        api.teams.listMembers(activeTeamId),
        api.teams.listTeamInvites(activeTeamId),
        api.teams.myInvites(),
      ]);
      setMembers(m);
      setPendingInvites(pi);
      setMyInvites(mi);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, [activeTeamId]);

  async function handleRemove(userId: string, username: string) {
    if (!activeTeamId || !confirm(`Remove "${username}" from this team?`)) return;
    try {
      await api.teams.removeMember(activeTeamId, userId);
      toast.success(`${username} removed`);
      loadAll();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleCancelInvite(inviteId: string) {
    if (!activeTeamId) return;
    try {
      await api.teams.cancelInvite(activeTeamId, inviteId);
      toast.success('Invite cancelled');
      loadAll();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleAccept(inviteId: string) {
    try {
      await api.teams.acceptInvite(inviteId);
      toast.success('Invite accepted');
      loadAll();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDecline(inviteId: string) {
    try {
      await api.teams.declineInvite(inviteId);
      toast.success('Invite declined');
      loadAll();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        onClick={() => router.push('/dashboard')}
      >
        <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
        Back to projects
      </Button>

      {/* Incoming invites */}
      {myInvites.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/20">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Mail className="h-4 w-4 text-blue-600" />
            Pending Invites ({myInvites.length})
          </h2>
          <div className="space-y-2">
            {myInvites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between rounded-md border bg-card p-3"
              >
                <div>
                  <p className="text-sm font-medium">{inv.teamName}</p>
                  <p className="text-xs text-muted-foreground">
                    Invited by {inv.invitedBy}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8"
                    onClick={() => handleAccept(inv.id)}
                  >
                    <Check className="mr-1 h-3.5 w-3.5" />
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => handleDecline(inv.id)}
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Team Settings</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={loadAll}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Invite
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Members */}
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">User</th>
                  <th className="px-4 py-2 text-left font-medium">Email</th>
                  <th className="px-4 py-2 text-left font-medium">Role</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {m.role === 'OWNER' && <Crown className="h-4 w-4 text-amber-500" />}
                        <span className="font-medium">{m.username}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{m.email}</td>
                    <td className="px-4 py-3">
                      <Badge variant={m.role === 'OWNER' ? 'default' : 'secondary'}>
                        {m.role}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {m.role !== 'OWNER' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive/70 hover:text-destructive"
                          onClick={() => handleRemove(m.id, m.username)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}

                {/* Pending invites in same table */}
                {pendingInvites.map((inv) => (
                  <tr key={inv.id} className="border-b last:border-0 bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-muted-foreground">
                          {inv.invitedUser.username}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {inv.invitedUser.email}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">PENDING</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive/70 hover:text-destructive"
                        onClick={() => handleCancelInvite(inv.id)}
                        title="Cancel invite"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTeamId && (
        <InviteDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          teamId={activeTeamId}
          onInvited={loadAll}
        />
      )}
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  teamId,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  teamId: string;
  onInvited: () => void;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.teams.sendInvite(teamId, value.trim());
      toast.success('Invite sent');
      setValue('');
      onOpenChange(false);
      onInvited();
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
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Enter the username or email of a Kolaybase user. They will receive
            an invite they can accept or decline.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="inv-user">Username or Email</Label>
            <Input
              id="inv-user"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="username or user@example.com"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !value.trim()}>
              {saving ? 'Sending...' : 'Send Invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
