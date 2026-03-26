'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TeamMember, TeamInvite, PendingInvite, TeamGitHubStatus, TeamVercelStatus } from '@/lib/types';
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
  Clock,
  Crown,
  ExternalLink,
  Github,
  Loader2,
  Eye,
  EyeOff,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Unplug,
  Users,
  X,
  Zap,
} from 'lucide-react';

function VercelLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 76 65" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
    </svg>
  );
}

// ── Team Integrations Section ─────────────────────────────────

function TeamIntegrationsSection({ teamId }: { teamId: string }) {
  const [githubStatus, setGithubStatus] = useState<TeamGitHubStatus | null>(null);
  const [vercelStatus, setVercelStatus] = useState<TeamVercelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [connectingVercel, setConnectingVercel] = useState(false);
  const [disconnectingGitHub, setDisconnectingGitHub] = useState(false);
  const [disconnectingVercel, setDisconnectingVercel] = useState(false);
  const [vercelToken, setVercelToken] = useState('');
  const [showVercelInput, setShowVercelInput] = useState(false);
  const [showVercelToken, setShowVercelToken] = useState(false);

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
  }, [teamId]);

  async function handleConnectGitHub() {
    setConnectingGitHub(true);
    try {
      const { url } = await api.teamIntegrations.getGitHubConnectUrl(teamId);
      window.location.href = url;
    } catch (err: any) {
      toast.error(err.message || 'Failed to start GitHub OAuth');
      setConnectingGitHub(false);
    }
  }

  async function handleDisconnectGitHub() {
    if (!confirm('Disconnect GitHub from this team? Project integrations using this connection may stop working.')) return;
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
    if (!vercelToken.trim()) {
      toast.error('Please enter your Vercel token');
      return;
    }
    setConnectingVercel(true);
    try {
      await api.teamIntegrations.connectVercelWithToken(teamId, vercelToken.trim());
      toast.success('Vercel connected successfully!');
      setVercelToken('');
      setShowVercelInput(false);
      loadStatuses();
    } catch (err: any) {
      toast.error(err.message || 'Failed to connect Vercel');
    } finally {
      setConnectingVercel(false);
    }
  }

  async function handleDisconnectVercel() {
    if (!confirm('Disconnect Vercel from this team? Project integrations using this connection may stop working.')) return;
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
        <div className="grid gap-4 sm:grid-cols-2">
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

            {githubStatus?.connected ? (
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
              <div className="space-y-2">
                {!githubStatus?.oauthConfigured && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-md px-3 py-2">
                    OAuth not configured. Set <code className="font-mono">GITHUB_TEAMS_CLIENT_ID</code> and <code className="font-mono">GITHUB_TEAMS_CLIENT_SECRET</code>.
                  </p>
                )}
                <Button
                  className="w-full bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 text-white dark:text-black"
                  size="sm"
                  onClick={handleConnectGitHub}
                  disabled={connectingGitHub || !githubStatus?.oauthConfigured}
                >
                  {connectingGitHub ? (
                    <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />Redirecting...</>
                  ) : (
                    <><Github className="h-3.5 w-3.5 mr-2" />Connect GitHub</>
                  )}
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  <a
                    href="https://github.com/settings/developers"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline dark:text-blue-400 inline-flex items-center gap-1"
                  >
                    Create OAuth App at GitHub <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              </div>
            )}
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

            {vercelStatus?.connected ? (
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
              <div className="space-y-2">
                {showVercelInput ? (
                  <>
                    <div className="relative">
                      <input
                        type={showVercelToken ? 'text' : 'password'}
                        placeholder="Paste your Vercel API token..."
                        value={vercelToken}
                        onChange={(e) => setVercelToken(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleConnectVercel()}
                        className="w-full rounded-md border bg-background px-3 py-1.5 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => setShowVercelToken((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        tabIndex={-1}
                      >
                        {showVercelToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="flex-1 bg-black hover:bg-zinc-800 text-white"
                        size="sm"
                        onClick={handleConnectVercel}
                        disabled={connectingVercel || !vercelToken.trim()}
                      >
                        {connectingVercel ? (
                          <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />Connecting...</>
                        ) : (
                          <><VercelLogo className="h-3.5 w-3.5 mr-2" />Connect</>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setShowVercelInput(false); setVercelToken(''); setShowVercelToken(false); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button
                    className="w-full bg-black hover:bg-zinc-800 text-white"
                    size="sm"
                    onClick={() => setShowVercelInput(true)}
                  >
                    <VercelLogo className="h-3.5 w-3.5 mr-2" />Connect Vercel
                  </Button>
                )}
                <p className="text-xs text-muted-foreground text-center">
                  <a
                    href="https://vercel.com/account/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline dark:text-blue-400 inline-flex items-center gap-1"
                  >
                    Create API Token at Vercel <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              </div>
            )}
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
  const { activeTeamId, setActiveTeamId, refreshTeams } = useActiveTeam();
  const currentUserId = parseJwt(getAccessToken() ?? '')?.sub ?? '';
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [myInvites, setMyInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Team name editing — owner only
  const [teamName, setTeamName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);

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
    if (!activeTeamId) return;
    setLoading(true);
    try {
      const [m, pi, mi, teams] = await Promise.all([
        api.teams.listMembers(activeTeamId),
        api.teams.listTeamInvites(activeTeamId),
        api.teams.myInvites(),
        api.teams.list(),
      ]);
      setMembers(m);
      setPendingInvites(pi);
      setMyInvites(mi);
      const current = teams.find((t) => t.id === activeTeamId);
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

      {/* Team Name — owner only */}
      {members.some((m) => m.id === currentUserId && m.role === 'OWNER') && (
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
        </div>
      )}

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
                        <span className="font-medium">{m.email}</span>
                      </div>
                    </td>
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
                {pendingInvites.map((inv) => {
                  const isEmailOnly = !inv.invitedUser.id;
                  return (
                    <tr key={inv.id} className="border-b last:border-0 bg-muted/20">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium text-muted-foreground">
                            {inv.invitedUser.email || inv.invitedEmail}
                          </span>
                          {isEmailOnly && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              Not registered
                            </Badge>
                          )}
                        </div>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Separator />

      {/* Integrations Section */}
      {activeTeamId && <TeamIntegrationsSection teamId={activeTeamId} />}

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
            Enter a username or email address. If they don't have an account yet,
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
