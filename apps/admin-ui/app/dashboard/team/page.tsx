'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { getDisplayName } from '@/lib/display-name';
import type { TeamMember, TeamInvite, PendingInvite, TeamGitHubStatus, TeamVercelStatus, ProjectListItem } from '@/lib/types';
import { useActiveTeam } from '../layout';
import { parseJwt, getAccessToken } from '@/lib/auth';
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
  ChevronDown,
  Clock,
  Crown,
  Github,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  Unplug,
  Users,
  X,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function VercelLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 76 65" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
    </svg>
  );
}

// ── Team Integrations Section ─────────────────────────────────

function TeamIntegrationsSection({ teamId, canManage, refreshKey }: { teamId: string; canManage: boolean; refreshKey?: number }) {
  const [githubStatus, setGithubStatus] = useState<TeamGitHubStatus | null>(null);
  const [vercelStatus, setVercelStatus] = useState<TeamVercelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [connectingVercel, setConnectingVercel] = useState(false);
  const [disconnectingGitHub, setDisconnectingGitHub] = useState(false);
  const [disconnectingVercel, setDisconnectingVercel] = useState(false);

  async function loadStatuses() {
    setLoading(true);
    try {
      const [gh, vc] = await Promise.all([
        api.teamIntegrations.getGitHubStatus(teamId),
        api.teamIntegrations.getVercelStatus(teamId),
      ]);
      setGithubStatus(gh);
      setVercelStatus(vc);
    } catch (err: any) {
      toast.error('Failed to load integration status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatuses();
  }, [teamId, refreshKey]);

  async function handleConnectGitHub() {
    setConnectingGitHub(true);
    try {
      const { url } = await api.teamIntegrations.getGitHubConnectUrl(teamId);
      window.location.href = url;
    } catch (err: any) {
      toast.error(err.message || 'Failed to start GitHub connection');
      setConnectingGitHub(false);
    }
  }

  async function handleDisconnectGitHub() {
    if (!(await confirmDialog({ title: 'Disconnect GitHub', description: 'Disconnect GitHub from this team? Project integrations using this connection may stop working.', confirmText: 'Disconnect', destructive: true }))) return;
    setDisconnectingGitHub(true);
    try {
      await api.teamIntegrations.disconnectGitHub(teamId);
      toast.success('GitHub disconnected');
      loadStatuses();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDisconnectingGitHub(false);
    }
  }

  async function handleConnectVercel() {
    setConnectingVercel(true);
    try {
      const { url } = await api.teamIntegrations.getVercelConnectUrl(teamId);
      window.location.href = url;
    } catch (err: any) {
      toast.error(err.message || 'Failed to start Vercel connection');
      setConnectingVercel(false);
    }
  }

  async function handleDisconnectVercel() {
    if (!(await confirmDialog({ title: 'Disconnect Vercel', description: 'Disconnect Vercel from this team? Project integrations using this connection may stop working.', confirmText: 'Disconnect', destructive: true }))) return;
    setDisconnectingVercel(true);
    try {
      await api.teamIntegrations.disconnectVercel(teamId);
      toast.success('Vercel disconnected');
      loadStatuses();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDisconnectingVercel(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Integrations</h2>
          <p className="text-sm text-muted-foreground">
            Connect GitHub and Vercel at the team level. Projects can then use these connections without individual tokens.
          </p>
        </div>
        <Button variant="outline" size="icon" onClick={loadStatuses} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="basefyio-grid-row-hover grid gap-4 sm:grid-cols-2">
          {/* GitHub Card */}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-900 dark:bg-zinc-100 shrink-0">
                <Github className="h-5 w-5 text-white dark:text-black" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">GitHub</span>
                  {githubStatus?.connected ? (
                    <Badge variant="default" className="text-[10px] h-4 bg-emerald-600">Connected</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] h-4">Not connected</Badge>
                  )}
                </div>
                {githubStatus?.connected && githubStatus.login && (
                  <p className="text-xs text-muted-foreground truncate flex items-center gap-1.5 mt-0.5">
                    {githubStatus.avatarUrl && (
                      <img src={githubStatus.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
                    )}
                    {githubStatus.login}
                  </p>
                )}
              </div>
            </div>

            {canManage && (githubStatus?.connected ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-200 dark:border-red-900"
                onClick={handleDisconnectGitHub}
                disabled={disconnectingGitHub}
              >
                <Unplug className="h-3.5 w-3.5 mr-2" />
                {disconnectingGitHub ? 'Disconnecting...' : 'Disconnect GitHub'}
              </Button>
            ) : (
              <Button
                className="w-full bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 text-white dark:text-black"
                size="sm"
                onClick={handleConnectGitHub}
                disabled={connectingGitHub}
              >
                {connectingGitHub ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />Redirecting...</>
                ) : (
                  <><Github className="h-3.5 w-3.5 mr-2" />Connect with GitHub</>
                )}
              </Button>
            ))}
          </div>

          {/* Vercel Card */}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-black dark:bg-white shrink-0">
                <VercelLogo className="h-4 w-4 text-white dark:text-black" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">Vercel</span>
                  {vercelStatus?.connected ? (
                    <Badge variant="default" className="text-[10px] h-4 bg-emerald-600">Connected</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] h-4">Not connected</Badge>
                  )}
                </div>
                {vercelStatus?.connected && vercelStatus.user && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {vercelStatus.user}
                    {vercelStatus.teamId && (
                      <span className="ml-1 font-mono text-[10px]">({vercelStatus.teamId})</span>
                    )}
                  </p>
                )}
              </div>
            </div>

            {canManage && (vercelStatus?.connected ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-200 dark:border-red-900"
                onClick={handleDisconnectVercel}
                disabled={disconnectingVercel}
              >
                <Unplug className="h-3.5 w-3.5 mr-2" />
                {disconnectingVercel ? 'Disconnecting...' : 'Disconnect Vercel'}
              </Button>
            ) : (
              <Button
                className="w-full bg-black hover:bg-zinc-800 text-white"
                size="sm"
                onClick={handleConnectVercel}
                disabled={connectingVercel}
              >
                {connectingVercel ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />Redirecting...</>
                ) : (
                  <><VercelLogo className="h-3.5 w-3.5 mr-2" />Connect with Vercel</>
                )}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────

export default function TeamSettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeTeamId, setActiveTeamId, viewTeamId, refreshTeams, refreshKey, teams: allTeams } = useActiveTeam();
  const currentUserId = parseJwt(getAccessToken() ?? '')?.sub ?? '';
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [teamProjects, setTeamProjects] = useState<ProjectListItem[]>([]);
  const [userProjectsDialog, setUserProjectsDialog] = useState<{ userId: string; name: string } | null>(null);
  /** Map of memberId → [{teamName, role}] for "All Teams" view */
  const [memberTeamRoles, setMemberTeamRoles] = useState<Record<string, { teamName: string; role: string }[]>>({});
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [myInvites, setMyInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [reinvitingInviteId, setReinvitingInviteId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Team name editing — owner only
  const [teamName, setTeamName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);

  // Transfer ownership
  const [transferTarget, setTransferTarget] = useState<TeamMember | null>(null);
  const [transferring, setTransferring] = useState(false);

  // Role permissions
  type RolePerms = Record<string, boolean>;
  const [rolePermissions, setRolePermissions] = useState<Record<string, RolePerms> | null>(null);
  const [draftPermissions, setDraftPermissions] = useState<Record<string, RolePerms> | null>(null);
  const [savingPermissions, setSavingPermissions] = useState(false);
  const permsDirty = !!(rolePermissions && draftPermissions && JSON.stringify(rolePermissions) !== JSON.stringify(draftPermissions));

  const currentUserRole = members.find((m) => m.id === currentUserId)?.role;
  const currentUserIsOwner = currentUserRole === 'OWNER';

  function hasPermission(perm: string): boolean {
    if (currentUserIsOwner) return true;
    if (!currentUserRole || !rolePermissions) return false;
    return rolePermissions[currentUserRole]?.[perm] ?? false;
  }

  // Handle OAuth callback query params
  useEffect(() => {
    const githubConnected = searchParams.get('github_connected');
    const githubError = searchParams.get('github_error');
    const vercelConnected = searchParams.get('vercel_connected');
    const vercelError = searchParams.get('vercel_error');

    if (githubConnected === '1') {
      toast.success('GitHub connected successfully!');
      router.replace('/dashboard/team');
    } else if (githubError) {
      toast.error(`GitHub connection failed: ${githubError.replace(/_/g, ' ')}`);
      router.replace('/dashboard/team');
    } else if (vercelConnected === '1') {
      toast.success('Vercel connected successfully!');
      router.replace('/dashboard/team');
    } else if (vercelError) {
      toast.error(`Vercel connection failed: ${vercelError.replace(/_/g, ' ')}`);
      router.replace('/dashboard/team');
    }
  }, [searchParams]);

  async function loadAll() {
    setLoading(true);
    try {
      const allTeams = await api.teams.list();

      // The dashboard's active team can be briefly unresolved on first paint, or
      // empty in the "All Teams" view — fall back to the first (personal) team so
      // the Members list isn't stuck empty.
      const teamId = activeTeamId || allTeams[0]?.id;
      if (!teamId) {
        setMembers([]);
        return;
      }

      // Build member-team-roles map from all teams
      const roleMap: Record<string, { teamName: string; role: string }[]> = {};
      const allTeamMembers = await Promise.all(
        allTeams.map((t) =>
          api.teams.listMembers(t.id)
            .then((ms) => ms.map((m) => ({ ...m, _teamName: t.name, _teamRole: m.role })))
            .catch(() => []),
        ),
      );
      for (const chunk of allTeamMembers) {
        for (const m of chunk) {
          if (!roleMap[m.id]) roleMap[m.id] = [];
          roleMap[m.id].push({ teamName: (m as any)._teamName, role: (m as any)._teamRole });
        }
      }
      setMemberTeamRoles(roleMap);

      const [m, pi, mi, rp, projects] = await Promise.all([
        api.teams.listMembers(teamId),
        api.teams.listTeamInvites(teamId),
        api.teams.myInvites(),
        api.teams.getRolePermissions(teamId),
        api.projects.list(teamId),
      ]);
      setMembers(m);
      setTeamProjects(projects);
      setPendingInvites(pi);
      setMyInvites(mi);
      setRolePermissions(rp);
      setDraftPermissions(rp);
      const current = allTeams.find((t) => t.id === teamId);
      if (current) setTeamName(current.name);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveTeamName() {
    if (!activeTeamId || !teamName.trim()) return;
    setSavingName(true);
    try {
      await api.teams.updateTeam(activeTeamId, teamName.trim());
      toast.success('Team name updated');
      setEditingName(false);
      refreshTeams();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update team name');
    } finally {
      setSavingName(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, [activeTeamId, refreshKey]);

  async function handleTransferOwnership() {
    if (!activeTeamId || !transferTarget) return;
    setTransferring(true);
    try {
      await api.teams.transferOwnership(activeTeamId, transferTarget.id);
      toast.success(`Ownership transferred to ${getDisplayName(transferTarget)}`);
      setTransferTarget(null);
      loadAll();
      refreshTeams();
    } catch (err: any) {
      toast.error(err.message || 'Failed to transfer ownership');
    } finally {
      setTransferring(false);
    }
  }

  async function handleDeleteTeam() {
    if (!activeTeamId) return;
    if (
      !(await confirmDialog({
        title: 'Delete team',
        description: 'Delete this team? Team must not have projects. This action cannot be undone.',
        confirmText: 'Delete team',
        destructive: true,
      }))
    ) {
      return;
    }

    try {
      const deletedId = activeTeamId;
      await api.teams.deleteTeam(deletedId);
      const teams = await api.teams.list();
      if (teams.length > 0) {
        const nextTeamId = teams[0].id;
        await api.teams.setActive(nextTeamId);
        setActiveTeamId(nextTeamId);
      } else {
        setActiveTeamId('');
      }
      refreshTeams();
      toast.success('Team deleted');
      router.push('/dashboard/projects');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete team');
    }
  }

  async function handleRemove(userId: string, displayName: string) {
    if (!activeTeamId) return;
    if (!(await confirmDialog({ title: 'Remove member', description: `Remove "${displayName}" from this team?`, confirmText: 'Remove', destructive: true }))) return;
    try {
      await api.teams.removeMember(activeTeamId, userId);
      toast.success(`${displayName} removed`);
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

  async function handleReInvite(inviteId: string) {
    if (!activeTeamId) return;
    setReinvitingInviteId(inviteId);
    try {
      const res = await api.teams.reInvite(activeTeamId, inviteId);
      toast.success(res.message || 'Reminder email sent');
    } catch (err: any) {
      toast.error(err.message || 'Failed to send reminder email');
    } finally {
      setReinvitingInviteId(null);
    }
  }

  async function handleAccept(inviteId: string) {
    try {
      await api.teams.acceptInvite(inviteId);
      toast.success('Invite accepted');
      loadAll();
      refreshTeams();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDecline(inviteId: string) {
    try {
      await api.teams.declineInvite(inviteId);
      toast.success('Invite declined');
      loadAll();
      refreshTeams();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
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
                  <p className="text-sm font-medium">{inv.organization || inv.teamName}</p>
                  <p className="text-xs text-muted-foreground">
                    Invited by {inv.invitedByFullName || inv.invitedBy}
                    {inv.invitedByEmail ? ` (${inv.invitedByEmail})` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Invite email: {inv.invitedEmail || 'N/A'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Invite date: {new Date(inv.createdAt).toLocaleString('tr-TR')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Valid until:{' '}
                    {inv.expiresAt
                      ? new Date(inv.expiresAt).toLocaleString('tr-TR')
                      : 'N/A'}
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
          {hasPermission('canInviteMembers') && (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Invite
            </Button>
          )}
        </div>
      </div>

      {/* Team Name — owner or users with canRenameTeam */}
      {hasPermission('canRenameTeam') && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Team Name</h2>
              <p className="text-xs text-muted-foreground">Only the team owner can change this.</p>
            </div>
            {!editingName && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditingName(true)}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            )}
          </div>

          {editingName ? (
            <div className="flex items-center gap-2">
              <Input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveTeamName();
                  if (e.key === 'Escape') setEditingName(false);
                }}
                maxLength={60}
                autoFocus
                className="h-9 text-sm"
              />
              <Button
                size="sm"
                onClick={handleSaveTeamName}
                disabled={savingName || !teamName.trim()}
              >
                {savingName ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditingName(false)}
                disabled={savingName}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <p className="text-sm font-medium">{teamName}</p>
          )}
          {currentUserIsOwner && !allTeams.find((t) => t.id === activeTeamId)?.isPersonal && (
            <div className="pt-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteTeam}
                disabled={members.length === 0}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete Team
              </Button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Members */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="border-b bg-muted/40 px-4 py-2.5 flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">Members</span>
              <span className="ml-auto text-xs text-muted-foreground">{members.length} member{members.length !== 1 ? 's' : ''}</span>
            </div>

            <div className="divide-y">
              {members.map((m) => {
                const displayName = getDisplayName(m);
                const initials = m.firstName && m.lastName
                  ? `${m.firstName[0]}${m.lastName[0]}`.toUpperCase()
                  : displayName.slice(0, 2).toUpperCase();
                const isOwner = m.role === 'OWNER';
                const isAdmin = m.role === 'ADMIN';
                const currentUserIsOwner = members.some((x) => x.id === currentUserId && x.role === 'OWNER');

                return (
                  <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                    {/* Avatar with optional crown */}
                    <div className="relative shrink-0">
                      <div className="h-10 w-10 rounded-full overflow-hidden ring-2 ring-border">
                        {m.avatarUrl ? (
                          <img src={m.avatarUrl} alt={displayName} className="h-full w-full object-cover" />
                        ) : (
                          <div className="h-full w-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                            {initials}
                          </div>
                        )}
                      </div>
                      {isOwner && (
                        <div className="absolute -top-1.5 left-1/2 -translate-x-1/2">
                          <Crown className="h-3.5 w-3.5 text-amber-500 drop-shadow-sm" fill="#f59e0b" />
                        </div>
                      )}
                    </div>

                    {/* Name + email */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{displayName}</span>
                        {isOwner && (
                          <Badge className="text-[10px] h-4 px-1.5 bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800">
                            Owner
                          </Badge>
                        )}
                        {isAdmin && (
                          <Badge className="text-[10px] h-4 px-1.5 bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800">
                            Admin
                          </Badge>
                        )}
                        {m.id === currentUserId && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                            You
                          </Badge>
                        )}
                        {(() => {
                          const count = teamProjects.filter((p) => p.createdBy === m.id).length;
                          if (count === 0) return null;
                          return (
                            <button
                              type="button"
                              onClick={() => setUserProjectsDialog({ userId: m.id, name: displayName })}
                              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                            >
                              {count} project{count !== 1 ? 's' : ''}
                            </button>
                          );
                        })()}
                      </div>
                      <div className="flex items-center gap-1 flex-wrap">
                        <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                        {memberTeamRoles[m.id]?.length > 0 && (
                          <span className="text-[10px] text-muted-foreground/60">·</span>
                        )}
                        {memberTeamRoles[m.id]?.map((tr) => (
                          <span
                            key={tr.teamName}
                            className={`inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium border ${
                              tr.role === 'OWNER'
                                ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800'
                                : tr.role === 'ADMIN'
                                ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800'
                                : 'bg-muted text-muted-foreground border-border'
                            }`}
                          >
                            {tr.teamName}: {tr.role.charAt(0) + tr.role.slice(1).toLowerCase()}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Actions for non-owner members */}
                    {!isOwner && m.id !== currentUserId && (currentUserIsOwner || hasPermission('canRemoveMembers')) && (
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Role change dropdown — owner only */}
                        {currentUserIsOwner && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs gap-1"
                              >
                                {isAdmin ? (
                                  <><Shield className="h-3 w-3" />Admin</>
                                ) : (
                                  <><Users className="h-3 w-3" />Member</>
                                )}
                                <ChevronDown className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={async () => {
                                  try {
                                    await api.teams.updateMemberRole(activeTeamId!, m.id, 'ADMIN');
                                    toast.success(`${displayName} is now an Admin`);
                                    loadAll();
                                  } catch (err: any) {
                                    toast.error(err.message);
                                  }
                                }}
                                disabled={isAdmin}
                              >
                                <Shield className="h-3.5 w-3.5 mr-2" />
                                Admin
                                {isAdmin && <Check className="h-3.5 w-3.5 ml-auto" />}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={async () => {
                                  try {
                                    await api.teams.updateMemberRole(activeTeamId!, m.id, 'MEMBER');
                                    toast.success(`${displayName} is now a Member`);
                                    loadAll();
                                  } catch (err: any) {
                                    toast.error(err.message);
                                  }
                                }}
                                disabled={m.role === 'MEMBER'}
                              >
                                <Users className="h-3.5 w-3.5 mr-2" />
                                Member
                                {m.role === 'MEMBER' && <Check className="h-3.5 w-3.5 ml-auto" />}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        {/* Transfer ownership — owner only */}
                        {currentUserIsOwner && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-amber-600"
                            title="Transfer ownership to this member"
                            onClick={() => setTransferTarget(m)}
                          >
                            <Crown className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {/* Remove member — permission based */}
                        {hasPermission('canRemoveMembers') && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive/60 hover:text-destructive"
                            onClick={() => handleRemove(m.id, displayName)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Pending invites */}
              {pendingInvites.map((inv) => {
                const isEmailOnly = !inv.invitedUser.id;
                return (
                  <div key={inv.id} className="flex items-center gap-3 px-4 py-3 bg-muted/20">
                    {/* Placeholder avatar */}
                    <div className="relative shrink-0">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center ring-2 ring-border ring-dashed">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-muted-foreground truncate">
                          {inv.invitedUser.email || inv.invitedEmail}
                        </span>
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5">Pending</Badge>
                        {isEmailOnly && (
                          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">Not registered</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">Invite sent</p>
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={reinvitingInviteId === inv.id}
                        onClick={() => handleReInvite(inv.id)}
                        title="Send reminder email"
                      >
                        {reinvitingInviteId === inv.id ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Mail className="mr-1 h-3.5 w-3.5" />
                        )}
                        Re-invite
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-destructive/60 hover:text-destructive"
                        onClick={() => handleCancelInvite(inv.id)}
                        title="Cancel invite"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <Separator />

      {/* Role Permissions Matrix — owner only */}
      {currentUserIsOwner && activeTeamId && draftPermissions && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Role Permissions</h2>
            <p className="text-sm text-muted-foreground">
              Configure what each role can do in this team. Only the team owner can change these settings.
            </p>
          </div>

          <div className="rounded-xl border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-2.5 font-medium">Permission</th>
                  <th className="text-center px-4 py-2.5 font-medium w-24">
                    <div className="flex items-center justify-center gap-1.5">
                      <Crown className="h-3 w-3 text-amber-500" />
                      Owner
                    </div>
                  </th>
                  <th className="text-center px-4 py-2.5 font-medium w-24">
                    <div className="flex items-center justify-center gap-1.5">
                      <Shield className="h-3 w-3 text-blue-500" />
                      Admin
                    </div>
                  </th>
                  <th className="text-center px-4 py-2.5 font-medium w-24">
                    <div className="flex items-center justify-center gap-1.5">
                      <Users className="h-3 w-3 text-muted-foreground" />
                      Member
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {([
                  { key: '', label: 'Team Settings', isHeader: true },
                  { key: 'canRenameTeam', label: 'Rename team' },
                  { key: 'canInviteMembers', label: 'Invite & re-invite members' },
                  { key: 'canRemoveMembers', label: 'Remove members' },
                  { key: 'canManageIntegrations', label: 'Manage integrations' },
                  { key: '', label: 'Projects', isHeader: true },
                  { key: 'canCreateProjects', label: 'Create projects' },
                  { key: 'canDeleteProjects', label: 'Delete projects' },
                  { key: 'canRestoreProjects', label: 'Restore deleted projects' },
                  { key: 'canMoveProjects', label: 'Move projects between teams' },
                  { key: '', label: 'Database', isHeader: true },
                  { key: 'canResetDbPassword', label: 'Reset database password' },
                  { key: '', label: 'Billing', isHeader: true },
                  { key: 'canViewBilling', label: 'View billing & invoices' },
                  { key: 'canManageBilling', label: 'Manage plans & payments' },
                ] as Array<{ key: string; label: string; isHeader?: boolean }>).map(({ key, label, isHeader }) => (
                  isHeader ? (
                    <tr key={label} className="bg-muted/20">
                      <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</td>
                    </tr>
                  ) : (
                    <tr key={key}>
                      <td className="px-4 py-2.5 pl-6">{label}</td>
                      <td className="text-center px-4 py-2.5">
                        <Check className="h-4 w-4 text-emerald-500 mx-auto" />
                      </td>
                      {(['ADMIN', 'MEMBER'] as const).map((role) => (
                        <td key={role} className="text-center px-4 py-2.5">
                          <button
                            className="mx-auto flex items-center justify-center"
                            onClick={() => {
                              setDraftPermissions((prev) => prev ? {
                                ...prev,
                                [role]: { ...prev[role], [key]: !prev[role][key] },
                              } : prev);
                            }}
                          >
                            {draftPermissions[role]?.[key] ? (
                              <Check className="h-4 w-4 text-emerald-500" />
                            ) : (
                              <X className="h-4 w-4 text-muted-foreground/30" />
                            )}
                          </button>
                        </td>
                      ))}
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!permsDirty || savingPermissions}
              onClick={async () => {
                if (!activeTeamId || !draftPermissions || !rolePermissions) return;
                setSavingPermissions(true);
                try {
                  for (const role of ['ADMIN', 'MEMBER'] as const) {
                    const draft = draftPermissions[role];
                    const saved = rolePermissions[role];
                    if (JSON.stringify(draft) !== JSON.stringify(saved)) {
                      await api.teams.updateRolePermissions(activeTeamId, role, draft);
                    }
                  }
                  setRolePermissions({ ...draftPermissions });
                  toast.success('Permissions saved');
                } catch (err: any) {
                  toast.error(err.message);
                } finally {
                  setSavingPermissions(false);
                }
              }}
            >
              {savingPermissions ? (
                <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />Saving...</>
              ) : (
                <><Save className="h-3.5 w-3.5 mr-2" />Save Changes</>
              )}
            </Button>
          </div>
        </div>
      )}

      <Separator />

      {/* Integrations Section */}
      {activeTeamId && (
        <TeamIntegrationsSection
          teamId={activeTeamId}
          canManage={hasPermission('canManageIntegrations')}
          refreshKey={refreshKey}
        />
      )}

      {activeTeamId && (
        <InviteDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          teamId={activeTeamId}
          onInvited={loadAll}
        />
      )}

      {/* User Projects Dialog */}
      <Dialog open={!!userProjectsDialog} onOpenChange={(o) => { if (!o) setUserProjectsDialog(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Projects created by {userProjectsDialog?.name}</DialogTitle>
            <DialogDescription>
              {teamProjects.filter((p) => p.createdBy === userProjectsDialog?.userId).length} project(s) in this team
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto divide-y">
            {teamProjects
              .filter((p) => p.createdBy === userProjectsDialog?.userId)
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setUserProjectsDialog(null);
                    router.push(`/dashboard/projects/${p.id}`);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-2 py-3 text-left hover:bg-muted/50 rounded-lg transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {p.projectSizeBytes ? ` · ${(Number(p.projectSizeBytes) / 1024 / 1024).toFixed(1)} MB` : ''}
                    </p>
                  </div>
                  <Badge variant={p.status === 'ACTIVE' ? 'default' : 'secondary'} className="shrink-0 text-[10px]">
                    {p.status}
                  </Badge>
                </button>
              ))}
            {teamProjects.filter((p) => p.createdBy === userProjectsDialog?.userId).length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No projects found.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Transfer Ownership Confirmation */}
      <Dialog open={!!transferTarget} onOpenChange={(o) => { if (!o) setTransferTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transfer Ownership</DialogTitle>
            <DialogDescription>
              Are you sure you want to transfer ownership to{' '}
              <strong>
                {transferTarget ? getDisplayName(transferTarget) : ''}
              </strong>?
              <br />
              <span className="text-destructive">You will become a regular member and lose owner privileges.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferTarget(null)} disabled={transferring}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleTransferOwnership}
              disabled={transferring}
            >
              {transferring ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Transferring...</>
              ) : (
                <><Crown className="h-4 w-4 mr-2" />Transfer Ownership</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            Enter an email address. If they don't have an account yet,
            they'll receive an email to sign up and join your team.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="inv-user">Username or Email</Label>
            <Input
              id="inv-user"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="user@example.com"
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
