'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { getDisplayName } from '@/lib/display-name';
import type { Team, TeamMember, TeamInvite, PendingInvite, TeamGitHubStatus, TeamVercelStatus, ProjectListItem } from '@/lib/types';
import { TeamScopePicker } from '@/components/team-scope-picker';
import { useActiveTeam } from '../layout';
import { parseJwt, getAccessToken } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn, projectStatusBadgeClass } from '@/lib/utils';
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
  LogOut,
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
        <Button
          variant="outline"
          size="icon"
          onClick={loadStatuses}
          disabled={loading}
          aria-label="Refresh integrations"
          title="Refresh integrations"
        >
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
                    Connected as {githubStatus.login}
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
                {/* The name is the Vercel account that connected; the ID is the
                    Vercel team it connected. Two of your teams can share a Vercel
                    team while different people connected them — label both. */}
                {vercelStatus?.connected && (vercelStatus.user || vercelStatus.teamId) && (
                  <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
                    {vercelStatus.user && (
                      <p className="truncate">Connected by {vercelStatus.user}</p>
                    )}
                    {vercelStatus.teamId && (
                      <p className="truncate">
                        Vercel team ID: <span className="font-mono text-[10px]">{vercelStatus.teamId}</span>
                      </p>
                    )}
                  </div>
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };

type TeamRoleChip = { teamId: string; teamName: string; role: string };

export default function TeamSettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    activeTeamId,
    setActiveTeamId,
    viewTeamId,
    setViewTeamId,
    refreshTeams,
    refreshKey,
    teams: contextTeams,
  } = useActiveTeam();
  const currentUserId = parseJwt(getAccessToken() ?? '')?.sub ?? '';
  const [pageTeams, setPageTeams] = useState<Team[] | null>(null);
  const allTeams = pageTeams ?? contextTeams;

  // Team settings belong to exactly one team. With "All Teams" selected the
  // page asks which one instead of quietly showing whichever was active.
  const isAllView = viewTeamId === 'all';
  const requestedTeamId = isAllView ? '' : viewTeamId || activeTeamId;
  const teamKnown = !pageTeams || pageTeams.some((t) => t.id === requestedTeamId);
  const teamId = requestedTeamId && teamKnown ? requestedTeamId : '';
  const currentTeam = allTeams.find((t) => t.id === teamId) ?? null;

  const [members, setMembers] = useState<TeamMember[]>([]);
  const loadSeq = useRef(0);
  const [teamProjects, setTeamProjects] = useState<ProjectListItem[]>([]);
  const [userProjectsDialog, setUserProjectsDialog] = useState<{ userId: string; name: string } | null>(null);
  /** memberId → the teams (of yours) they belong to, with their role there */
  const [memberTeamRoles, setMemberTeamRoles] = useState<Record<string, TeamRoleChip[]>>({});
  /** Everyone across your teams, one row per person (All Teams view). */
  const [allPeople, setAllPeople] = useState<TeamMember[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [myInvites, setMyInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [reinvitingInviteId, setReinvitingInviteId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Team name editing — owner or roles with canRenameTeam
  const [teamName, setTeamName] = useState('');
  const [savedTeamName, setSavedTeamName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);

  // Transfer ownership
  const [transferTarget, setTransferTarget] = useState<TeamMember | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [leaving, setLeaving] = useState(false);

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
    // Guard against out-of-order responses: only the latest call may commit.
    const seq = ++loadSeq.current;
    const stillCurrent = () => seq === loadSeq.current;
    setLoading(true);
    try {
      const teams = await api.teams.list();
      if (!stillCurrent()) return;
      setPageTeams(teams);

      const scopedTeamId =
        requestedTeamId && teams.some((t) => t.id === requestedTeamId) ? requestedTeamId : '';

      // Every team's member list: the per-member team chips, and the
      // de-duplicated "people across your teams" list of the All Teams view.
      const membersByTeam = Promise.all(
        teams.map((t) =>
          api.teams
            .listMembers(t.id)
            .then((ms) => ({ team: t, members: ms }))
            .catch(() => ({ team: t, members: [] as TeamMember[] })),
        ),
      );

      if (!scopedTeamId) {
        const [chunks, mi] = await Promise.all([membersByTeam, api.teams.myInvites()]);
        if (!stillCurrent()) return;
        applyPeople(chunks);
        setMyInvites(mi);
        setMembers([]);
        setPendingInvites([]);
        setTeamProjects([]);
        setRolePermissions(null);
        setDraftPermissions(null);
        return;
      }

      const [chunks, m, pi, mi, rp, projects] = await Promise.all([
        membersByTeam,
        api.teams.listMembers(scopedTeamId),
        api.teams.listTeamInvites(scopedTeamId),
        api.teams.myInvites(),
        api.teams.getRolePermissions(scopedTeamId),
        api.projects.list(scopedTeamId),
      ]);
      if (!stillCurrent()) return; // a newer load superseded this one
      applyPeople(chunks);
      setMembers(m);
      setTeamProjects(projects);
      setPendingInvites(pi);
      setMyInvites(mi);
      setRolePermissions(rp);
      setDraftPermissions(rp);
      const current = teams.find((t) => t.id === scopedTeamId);
      if (current) {
        setTeamName(current.name);
        setSavedTeamName(current.name);
        setEditingName(false);
      }
    } catch (err: any) {
      if (stillCurrent()) toast.error(err.message);
    } finally {
      if (stillCurrent()) setLoading(false);
    }
  }

  function applyPeople(chunks: { team: Team; members: TeamMember[] }[]) {
    const roleMap: Record<string, TeamRoleChip[]> = {};
    const people = new Map<string, TeamMember>();
    for (const { team, members: ms } of chunks) {
      for (const m of ms) {
        (roleMap[m.id] ??= []).push({ teamId: team.id, teamName: team.name, role: m.role });
        if (!people.has(m.id)) people.set(m.id, m);
      }
    }
    setMemberTeamRoles(roleMap);
    setAllPeople(
      [...people.values()].sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b))),
    );
  }

  function cancelEditName() {
    setTeamName(savedTeamName);
    setEditingName(false);
  }

  async function handleSaveTeamName() {
    const next = teamName.trim();
    if (!teamId || !next) return;
    setSavingName(true);
    try {
      await api.teams.updateTeam(teamId, next);
      toast.success('Team name updated');
      setTeamName(next);
      setSavedTeamName(next);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTeamId, refreshKey]);

  async function handleTransferOwnership() {
    if (!teamId || !transferTarget) return;
    setTransferring(true);
    try {
      await api.teams.transferOwnership(teamId, transferTarget.id);
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

  /** After deleting or leaving a team, land on another one the user still has. */
  async function moveToRemainingTeam() {
    const teams = await api.teams.list();
    const next = teams.find((t) => t.isPersonal) ?? teams[0];
    if (next) {
      await api.teams.setActive(next.id).catch(() => {});
      setViewTeamId(next.id);
      setActiveTeamId(next.id);
    } else {
      setViewTeamId('all');
    }
    refreshTeams();
  }

  async function handleDeleteTeam() {
    if (!teamId) return;
    if (
      !(await confirmDialog({
        title: 'Delete team',
        description: `Delete "${savedTeamName}"? The team must not have projects. This action cannot be undone.`,
        confirmText: 'Delete team',
        destructive: true,
      }))
    ) {
      return;
    }

    try {
      await api.teams.deleteTeam(teamId);
      await moveToRemainingTeam();
      toast.success('Team deleted');
      router.push('/dashboard/projects');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete team');
    }
  }

  async function handleLeaveTeam() {
    if (!teamId) return;
    if (
      !(await confirmDialog({
        title: 'Leave team',
        description: `Leave "${savedTeamName}"? You will lose access to its projects until someone invites you again.`,
        confirmText: 'Leave team',
        destructive: true,
      }))
    ) {
      return;
    }
    setLeaving(true);
    try {
      await api.teams.leaveTeam(teamId);
      await moveToRemainingTeam();
      toast.success(`You left ${savedTeamName}`);
      router.push('/dashboard');
    } catch (err: any) {
      toast.error(err.message || 'Failed to leave the team');
    } finally {
      setLeaving(false);
    }
  }

  async function handleRemove(userId: string, displayName: string) {
    if (!teamId) return;
    if (!(await confirmDialog({ title: 'Remove member', description: `Remove "${displayName}" from this team?`, confirmText: 'Remove', destructive: true }))) return;
    try {
      await api.teams.removeMember(teamId, userId);
      toast.success(`${displayName} removed`);
      loadAll();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleCancelInvite(inviteId: string) {
    if (!teamId) return;
    try {
      await api.teams.cancelInvite(teamId, inviteId);
      toast.success('Invite cancelled');
      loadAll();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleReInvite(inviteId: string) {
    if (!teamId) return;
    setReinvitingInviteId(inviteId);
    try {
      const res = await api.teams.reInvite(teamId, inviteId);
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

  const canInvite = !!teamId && hasPermission('canInviteMembers');
  const youAre =
    currentUserRole === 'OWNER' ? 'the owner' : currentUserRole === 'ADMIN' ? 'an admin' : currentUserRole ? 'a member' : null;
  const isPersonalTeam = !!currentTeam?.isPersonal;

  function renderTeamChips(memberId: string, excludeTeamId?: string) {
    const chips = (memberTeamRoles[memberId] ?? []).filter((tr) => tr.teamId !== excludeTeamId);
    if (chips.length === 0) return null;
    return (
      <>
        <span className="text-[10px] text-muted-foreground/60" aria-hidden>·</span>
        {chips.map((tr) => (
          <span
            key={tr.teamId}
            className={`inline-flex items-center rounded-full px-1.5 py-0 text-[9px] font-medium border ${
              tr.role === 'OWNER'
                ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800'
                : tr.role === 'ADMIN'
                ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800'
                : 'bg-muted text-muted-foreground border-border'
            }`}
          >
            {tr.teamName}: {ROLE_LABEL[tr.role] ?? tr.role}
          </span>
        ))}
      </>
    );
  }

  function renderAvatar(m: TeamMember, size: 'sm' | 'md' = 'md') {
    const displayName = getDisplayName(m);
    const initials = m.firstName && m.lastName
      ? `${m.firstName[0]}${m.lastName[0]}`.toUpperCase()
      : displayName.slice(0, 2).toUpperCase();
    const box = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
    return (
      <div className={`${box} rounded-full overflow-hidden ring-2 ring-border`}>
        {m.avatarUrl ? (
          <img src={m.avatarUrl} alt={displayName} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
            {initials}
          </div>
        )}
      </div>
    );
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
                    Invite date: {new Date(inv.createdAt).toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Valid until:{' '}
                    {inv.expiresAt
                      ? new Date(inv.expiresAt).toLocaleString()
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

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Team Settings</h1>
          <p className="truncate text-sm text-muted-foreground">
            {teamId
              ? <>Team: <span className="font-medium text-foreground">{currentTeam?.name ?? savedTeamName}</span>
                  {youAre && <> · You are {youAre}</>}
                </>
              : 'All Teams'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="icon" onClick={loadAll} aria-label="Refresh" title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          {canInvite && (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Invite
            </Button>
          )}
        </div>
      </div>

      {!teamId ? (
        <>
          <TeamScopePicker
            title="Choose a team to manage"
            description={
              isAllView
                ? 'You are viewing All Teams. Members, roles, invites and integrations belong to one team — pick the team you want to manage.'
                : 'The selected team is no longer available to you. Pick one of your teams.'
            }
            teams={allTeams}
          />

          {/* Everyone across the user's teams, so the Overview's member count is explained */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="border-b bg-muted/40 px-4 py-2.5 flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">People across your teams</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {loading ? '…' : `${allPeople.length} ${allPeople.length === 1 ? 'person' : 'people'} in ${allTeams.length} team${allTeams.length !== 1 ? 's' : ''}`}
              </span>
            </div>
            {loading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="divide-y">
                {allPeople.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="shrink-0">{renderAvatar(m, 'sm')}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{getDisplayName(m)}</span>
                        {m.id === currentUserId && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5">You</Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                        {renderTeamChips(m.id)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Team Name — owner or users with canRenameTeam */}
          {hasPermission('canRenameTeam') && (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold">Team Name</h2>
                  <p className="text-xs text-muted-foreground">
                    The owner, and roles allowed to rename the team under Role Permissions, can change this.
                  </p>
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
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveTeamName();
                        if (e.key === 'Escape') cancelEditName();
                      }}
                      maxLength={60}
                      autoFocus
                      aria-label="Team name"
                      aria-invalid={teamName.trim().length < 2}
                      className="h-9 text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={handleSaveTeamName}
                      disabled={savingName || teamName.trim().length < 2 || teamName.trim() === savedTeamName}
                      aria-label="Save team name"
                      title="Save team name"
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
                      onClick={cancelEditName}
                      disabled={savingName}
                      aria-label="Cancel renaming"
                      title="Cancel"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {teamName.trim().length < 2 && (
                    <p className="text-xs text-destructive">The team name needs at least 2 characters.</p>
                  )}
                </div>
              ) : (
                <p className="text-sm font-medium">{savedTeamName}</p>
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
                    const isOwner = m.role === 'OWNER';
                    const isAdmin = m.role === 'ADMIN';

                    return (
                      <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                        {/* Avatar with optional crown */}
                        <div className="relative shrink-0">
                          {renderAvatar(m)}
                          {isOwner && (
                            <div className="absolute -top-1.5 left-1/2 -translate-x-1/2">
                              <Crown className="h-3.5 w-3.5 text-amber-500 drop-shadow-sm" fill="#f59e0b" aria-hidden />
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
                                  title={`Projects ${displayName} created in this team`}
                                >
                                  {count} project{count !== 1 ? 's' : ''}
                                </button>
                              );
                            })()}
                          </div>
                          <div className="flex items-center gap-1 flex-wrap">
                            <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                            {renderTeamChips(m.id, teamId)}
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
                                    aria-label={`Change role of ${displayName}`}
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
                                        await api.teams.updateMemberRole(teamId, m.id, 'ADMIN');
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
                                        await api.teams.updateMemberRole(teamId, m.id, 'MEMBER');
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
                                aria-label={`Transfer ownership to ${displayName}`}
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
                                title="Remove from team"
                                aria-label={`Remove ${displayName} from the team`}
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
                    const target = inv.invitedUser.email || inv.invitedEmail || '';
                    return (
                      <div key={inv.id} className="flex items-center gap-3 px-4 py-3 bg-muted/20">
                        {/* Placeholder avatar */}
                        <div className="relative shrink-0">
                          <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center ring-2 ring-border ring-dashed">
                            <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
                          </div>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-muted-foreground truncate">
                              {target}
                            </span>
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5">Pending</Badge>
                            {isEmailOnly && (
                              <Badge variant="secondary" className="text-[10px] h-4 px-1.5" title="No basefyio account uses this email yet">
                                Not registered
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Invite sent{inv.role === 'ADMIN' ? ' · joins as Admin' : ''}
                          </p>
                        </div>

                        {canInvite && (
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
                              aria-label={`Cancel the invite for ${target}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          <Separator />

          {/* Role Permissions Matrix — owner only */}
          {currentUserIsOwner && draftPermissions && (
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
                          <Crown className="h-3 w-3 text-amber-500" aria-hidden />
                          Owner
                        </div>
                      </th>
                      <th className="text-center px-4 py-2.5 font-medium w-24">
                        <div className="flex items-center justify-center gap-1.5">
                          <Shield className="h-3 w-3 text-blue-500" aria-hidden />
                          Admin
                        </div>
                      </th>
                      <th className="text-center px-4 py-2.5 font-medium w-24">
                        <div className="flex items-center justify-center gap-1.5">
                          <Users className="h-3 w-3 text-muted-foreground" aria-hidden />
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
                            <Check className="h-4 w-4 text-emerald-500 mx-auto" aria-label="Always allowed" />
                          </td>
                          {(['ADMIN', 'MEMBER'] as const).map((role) => {
                            const allowed = !!draftPermissions[role]?.[key];
                            return (
                              <td key={role} className="text-center px-4 py-2.5">
                                <button
                                  type="button"
                                  className="mx-auto flex items-center justify-center"
                                  aria-pressed={allowed}
                                  aria-label={`${label} — ${ROLE_LABEL[role]}: ${allowed ? 'allowed' : 'not allowed'}`}
                                  title={`${allowed ? 'Allowed' : 'Not allowed'} — click to change`}
                                  onClick={() => {
                                    setDraftPermissions((prev) => prev ? {
                                      ...prev,
                                      [role]: { ...prev[role], [key]: !prev[role][key] },
                                    } : prev);
                                  }}
                                >
                                  {allowed ? (
                                    <Check className="h-4 w-4 text-emerald-500" />
                                  ) : (
                                    <X className="h-4 w-4 text-muted-foreground/30" />
                                  )}
                                </button>
                              </td>
                            );
                          })}
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
                    if (!teamId || !draftPermissions || !rolePermissions) return;
                    setSavingPermissions(true);
                    try {
                      for (const role of ['ADMIN', 'MEMBER'] as const) {
                        const draft = draftPermissions[role];
                        const saved = rolePermissions[role];
                        if (JSON.stringify(draft) !== JSON.stringify(saved)) {
                          await api.teams.updateRolePermissions(teamId, role, draft);
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
          <TeamIntegrationsSection
            teamId={teamId}
            canManage={hasPermission('canManageIntegrations')}
            refreshKey={refreshKey}
          />

          {/* Leave / delete */}
          {!loading && currentUserRole && (
            <>
              <Separator />
              <div className="rounded-lg border border-destructive/30 p-4 space-y-3">
                <div>
                  <h2 className="text-sm font-semibold">Leave or delete this team</h2>
                  <p className="text-xs text-muted-foreground">
                    {isPersonalTeam
                      ? 'This is your personal team. It cannot be left or deleted.'
                      : currentUserIsOwner
                        ? 'As the owner you cannot leave the team — transfer ownership to another member first. Deleting the team requires it to have no projects.'
                        : 'Leaving removes your access to this team and its projects.'}
                  </p>
                </div>
                {!isPersonalTeam && (
                  <div className="flex flex-wrap gap-2">
                    {currentUserIsOwner ? (
                      <Button variant="destructive" size="sm" onClick={handleDeleteTeam}>
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        Delete Team
                      </Button>
                    ) : (
                      <Button variant="destructive" size="sm" onClick={handleLeaveTeam} disabled={leaving}>
                        {leaving ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <LogOut className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Leave Team
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          <InviteDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            teamId={teamId}
            canInviteAdmins={currentUserIsOwner}
            onInvited={loadAll}
          />
        </>
      )}

      {/* User Projects Dialog */}
      <Dialog open={!!userProjectsDialog} onOpenChange={(o) => { if (!o) setUserProjectsDialog(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Projects created by {userProjectsDialog?.name}</DialogTitle>
            <DialogDescription>
              {teamProjects.filter((p) => p.createdBy === userProjectsDialog?.userId).length} project(s) in {currentTeam?.name ?? 'this team'}
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
                  <Badge variant="secondary" className={cn('shrink-0 text-[10px]', projectStatusBadgeClass(p.status))}>
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
  canInviteAdmins,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  teamId: string;
  canInviteAdmins: boolean;
  onInvited: () => void;
}) {
  const [value, setValue] = useState('');
  const [role, setRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const email = value.trim();
  const emailValid = EMAIL_RE.test(email);

  useEffect(() => {
    if (!open) {
      setValue('');
      setRole('MEMBER');
      setTouched(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!emailValid) return;
    setSaving(true);
    try {
      const res = await api.teams.sendInvite(teamId, email, canInviteAdmins ? role : undefined);
      toast.success(res?.message || 'Invite sent');
      onOpenChange(false);
      onInvited();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  const showError = touched && !!email && !emailValid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Enter an email address. If they don&apos;t have an account yet,
            they&apos;ll receive an email to sign up and join your team.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="inv-user">Email address</Label>
            <Input
              id="inv-user"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="user@example.com"
              aria-invalid={showError}
              aria-describedby={showError ? 'inv-user-error' : undefined}
              required
            />
            {showError && (
              <p id="inv-user-error" className="text-xs text-destructive">
                Enter a valid email address, like name@example.com.
              </p>
            )}
          </div>
          {canInviteAdmins && (
            <div className="space-y-2">
              <Label id="inv-role-label">Role</Label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby="inv-role-label">
                {([
                  { value: 'MEMBER', label: 'Member', hint: 'Works on projects', icon: Users },
                  { value: 'ADMIN', label: 'Admin', hint: 'Also manages the team', icon: Shield },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={role === opt.value}
                    onClick={() => setRole(opt.value)}
                    className={cn(
                      'flex items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      role === opt.value ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                    )}
                  >
                    <opt.icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                      <span className="block font-medium">{opt.label}</span>
                      <span className="block text-xs text-muted-foreground">{opt.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                What each role may do is set under Role Permissions.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !emailValid}>
              {saving ? 'Sending...' : 'Send Invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
