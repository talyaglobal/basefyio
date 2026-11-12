'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useLiveProjectRefresh } from '@/lib/use-live-refresh';
import type { RealmInfo, RealmUser, RealmUserDetail, RealmSession, RealmSessionFull, MfaUser, RealmPolicies, ProjectAuthConfig } from '@/lib/types';
import {
  DEFAULT_PASSWORD_RULES,
  isValidEmail,
  normalizePhone,
  passwordChecks,
  PASSWORD_MIN_LENGTH_BOUNDS,
  POLICY_BOUNDS,
  rangeError,
  TOKEN_LIFESPAN_BOUNDS,
  type PasswordRules,
} from '@/lib/project-auth-rules';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Info,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  X,
} from 'lucide-react';

function fmtTs(ts?: number | null) {
  return ts ? new Date(ts).toLocaleString() : '—';
}
function fmtDateOnly(ts?: number | null) {
  return ts ? new Date(ts).toLocaleDateString() : '—';
}

interface ProjectAuthProps {
  projectId: string;
}

type TabId = 'users' | 'sessions' | 'mfa' | 'policies' | 'settings' | 'providers' | 'email';

const USERS_PAGE_SIZE = 50;

export function ProjectAuth({ projectId }: ProjectAuthProps) {
  const [activeTab, setActiveTab] = useState<TabId>('users');
  const [realm, setRealm] = useState<RealmInfo | null>(null);
  const [users, setUsers] = useState<RealmUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userSearch, setUserSearch] = useState('');
  const [userPage, setUserPage] = useState(0);
  const [usersLoading, setUsersLoading] = useState(false);
  const [config, setConfig] = useState<ProjectAuthConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  // The search box and the pager drive the user list server-side, so a realm
  // with thousands of users is searchable and every page is reachable.
  const userQuery = useRef({ search: '', page: 0 });
  userQuery.current = { search: userSearch.trim(), page: userPage };

  const loadUsers = useCallback(async () => {
    const { search, page } = userQuery.current;
    setUsersLoading(true);
    try {
      const [u, c] = await Promise.all([
        api.projects.realmUsers(projectId, { search: search || undefined, first: page * USERS_PAGE_SIZE, max: USERS_PAGE_SIZE }),
        api.projects.countRealmUsers(projectId, search || undefined),
      ]);
      setUsers(u);
      setUserTotal(c.count);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load users');
    } finally {
      setUsersLoading(false);
    }
  }, [projectId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([
        api.projects.realmInfo(projectId),
        api.projects.getAuthConfig(projectId),
      ]);
      setRealm(r);
      setConfig(c);
      setLoadError(null);
      await loadUsers();
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load authentication');
    } finally {
      setLoading(false);
    }
  }, [projectId, loadUsers]);

  // Refetch the page when the search settles or the page changes.
  const firstUserLoad = useRef(true);
  useEffect(() => {
    if (firstUserLoad.current) {
      firstUserLoad.current = false;
      return;
    }
    const t = setTimeout(() => void loadUsers(), 300);
    return () => clearTimeout(t);
  }, [userSearch, userPage, loadUsers]);

  const repairRealm = useCallback(async () => {
    setRepairing(true);
    try {
      const res = await api.projects.repairRealm(projectId);
      toast.success(res.message || 'Authentication repaired');
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Repair failed');
    } finally {
      setRepairing(false);
    }
  }, [projectId, loadAll]);

  const [purging, setPurging] = useState(false);
  const purgeAnonymous = useCallback(async () => {
    setPurging(true);
    try {
      const preview = await api.projects.purgeAnonymousUsers(projectId, { olderThanDays: 30, dryRun: true });
      if (preview.matched === 0) {
        toast.info('No anonymous users older than 30 days');
        return;
      }
      const ok = await confirmDialog({
        title: 'Purge anonymous users',
        description: `Delete ${preview.matched} anonymous user${preview.matched === 1 ? '' : 's'} created more than 30 days ago? Their sessions have already expired. This cannot be undone.`,
        destructive: true,
      });
      if (!ok) return;
      const result = await api.projects.purgeAnonymousUsers(projectId, { olderThanDays: 30 });
      toast.success(`Deleted ${result.deleted} anonymous user${result.deleted === 1 ? '' : 's'}`);
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Purge failed');
    } finally {
      setPurging(false);
    }
  }, [projectId, loadAll]);

  useLiveProjectRefresh(projectId, ['auth.'], loadAll);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const refreshUsers = useCallback(async () => {
    await loadUsers();
    api.projects.realmInfo(projectId).then(setRealm).catch(() => undefined);
  }, [projectId, loadUsers]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (loadError && !realm) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-center">
          <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-red-500" />
          <h2 className="text-base font-semibold">Authentication service unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This project&apos;s authentication realm could not be loaded — it may be
            unhealthy and need to be re-provisioned. Re-provisioning creates a fresh
            realm; your project API keys are unchanged, but existing Keycloak users
            (SDK sign-in identities) will be reset.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => loadAll()} disabled={repairing}>
              Retry
            </Button>
            <Button onClick={repairRealm} disabled={repairing}>
              {repairing ? 'Repairing…' : 'Repair authentication'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'users', label: 'Users', icon: <Users className="h-3.5 w-3.5" /> },
    { id: 'sessions', label: 'Sessions', icon: <Monitor className="h-3.5 w-3.5" /> },
    { id: 'mfa', label: 'MFA', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
    { id: 'policies', label: 'Policies', icon: <Lock className="h-3.5 w-3.5" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="h-3.5 w-3.5" /> },
    { id: 'providers', label: 'Providers', icon: <KeyRound className="h-3.5 w-3.5" /> },
    { id: 'email', label: 'Email', icon: <Mail className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Authentication</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={loadAll}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          {activeTab === 'users' && users.some((u) => u.isAnonymous) && (
            <Button variant="outline" onClick={purgeAnonymous} disabled={purging} title="Delete anonymous users created more than 30 days ago">
              <Trash2 className="mr-2 h-4 w-4" />
              {purging ? 'Purging…' : 'Purge anonymous'}
            </Button>
          )}
          {activeTab === 'users' && (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add User
            </Button>
          )}
        </div>
      </div>

      {/* Realm stats */}
      {realm && (
        <div className="basefyio-grid-row-hover grid gap-4 sm:grid-cols-3">
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
            <div className="text-sm text-muted-foreground">SDK Auth Endpoints</div>
            <div className="mt-2 space-y-1 text-sm">
              <p>Signup: <Badge variant="outline" className="ml-1 font-mono text-xs">POST /api/rest/v1/auth/signup</Badge></p>
              <p>Signin: <Badge variant="outline" className="ml-1 font-mono text-xs">POST /api/rest/v1/auth/signin</Badge></p>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b">
        <nav className="-mb-px flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'users' && (
        <UsersTab
          users={users}
          total={userTotal}
          page={userPage}
          pageSize={USERS_PAGE_SIZE}
          search={userSearch}
          loading={usersLoading}
          onSearch={(s) => { setUserSearch(s); setUserPage(0); }}
          onPage={setUserPage}
          projectId={projectId}
          onRefresh={refreshUsers}
        />
      )}
      {activeTab === 'sessions' && <SessionsTab projectId={projectId} />}
      {activeTab === 'mfa' && <MfaTab projectId={projectId} />}
      {activeTab === 'policies' && <PoliciesTab projectId={projectId} />}
      {activeTab === 'settings' && config && (
        <SettingsTab
          projectId={projectId}
          config={config}
          onSaved={setConfig}
          onOpenPolicies={() => setActiveTab('policies')}
        />
      )}
      {activeTab === 'providers' && config && (
        <ProvidersTab projectId={projectId} config={config} onSaved={setConfig} />
      )}
      {activeTab === 'email' && config && (
        <EmailTab projectId={projectId} config={config} onSaved={setConfig} />
      )}

      <CreateUserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        onCreated={refreshUsers}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────── Users Tab */
function UsersTab({
  users,
  total,
  page,
  pageSize,
  search,
  loading,
  onSearch,
  onPage,
  projectId,
  onRefresh,
}: {
  users: RealmUser[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
  loading: boolean;
  onSearch: (s: string) => void;
  onPage: (p: number) => void;
  projectId: string;
  onRefresh: () => void | Promise<void>;
}) {
  const [editingUser, setEditingUser] = useState<RealmUser | null>(null);
  const [resetingUser, setResetingUser] = useState<RealmUser | null>(null);
  const [viewingUser, setViewingUser] = useState<RealmUser | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleDelete(userId: string, email: string) {
    if (!(await confirmDialog({ title: 'Delete user', description: `Delete user "${email}"? Their sessions end and the account cannot be restored.`, confirmText: 'Delete user', destructive: true }))) return;
    try {
      await api.projects.deleteRealmUser(projectId, userId);
      toast.success('User deleted');
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function copyId(id: string) {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, page * pageSize + users.length);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by email or name…"
          aria-label="Search users"
          className="max-w-sm"
        />
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {loading ? 'Loading…' : total === 0 ? 'No users' : `${from}–${to} of ${total.toLocaleString('en-US')} user${total === 1 ? '' : 's'}`}
        </p>
      </div>

      {users.length === 0 && !loading ? (
        search.trim() ? (
          <div className="flex h-32 flex-col items-center justify-center rounded-lg border border-dashed">
            <p className="font-medium">No users match &quot;{search.trim()}&quot;</p>
            <p className="text-sm text-muted-foreground">Try part of the email address or name.</p>
          </div>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed">
            <Users className="mb-3 h-10 w-10 text-muted-foreground/50" />
            <p className="font-medium">No users yet</p>
            <p className="text-sm text-muted-foreground">
              Users can sign up via SDK or be added manually above.
            </p>
          </div>
        )
      ) : (
      <div className={`rounded-md border overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2 text-left font-medium">User</th>
              <th className="px-4 py-2 text-left font-medium">UID</th>
              <th className="px-4 py-2 text-left font-medium">Phone</th>
              <th className="px-4 py-2 text-left font-medium">Confirmed</th>
              <th className="px-4 py-2 text-left font-medium">Created</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                className="border-b last:border-0 cursor-pointer hover:bg-muted/40"
                onClick={() => setViewingUser(u)}
              >
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2 font-medium">
                    {u.email}
                    {u.isAnonymous && (
                      <Badge variant="outline" className="text-[10px] uppercase" title="Created by anonymous sign-in; no real email">
                        Anonymous
                      </Badge>
                    )}
                    {u.mfaEnrollmentRequired && (
                      <Badge variant="outline" className="text-[10px] uppercase" title="This user must enroll an authenticator">
                        MFA required
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <button
                    type="button"
                    className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                    title="Copy user ID"
                    onClick={(e) => { e.stopPropagation(); copyId(u.id); }}
                  >
                    {u.id.slice(0, 8)}…
                    {copiedId === u.id ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                  </button>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{u.phoneNumber || '—'}</td>
                <td className="px-4 py-2">
                  {u.emailVerified ? (
                    <Badge variant="default" className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300">Confirmed</Badge>
                  ) : (
                    <Badge variant="secondary">Unconfirmed</Badge>
                  )}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{fmtDateOnly(u.createdTimestamp)}</td>
                <td className="px-4 py-2">
                  <Badge variant={u.enabled ? 'default' : 'secondary'}>
                    {u.enabled ? 'Active' : 'Disabled'}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="View details" aria-label="View details" onClick={() => setViewingUser(u)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit user" aria-label="Edit user" onClick={() => setEditingUser(u)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Reset password" aria-label="Reset password" onClick={() => setResetingUser(u)}>
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" title="Delete user" aria-label="Delete user" onClick={() => handleDelete(u.id, u.email)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Page {page + 1} of {pageCount}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0 || loading} onClick={() => onPage(page - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page + 1 >= pageCount || loading} onClick={() => onPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}

      <UserDetailDrawer
        user={viewingUser}
        projectId={projectId}
        onClose={() => setViewingUser(null)}
        onEdit={() => { setEditingUser(viewingUser); setViewingUser(null); }}
        onReset={() => { setResetingUser(viewingUser); setViewingUser(null); }}
        onDeleted={() => { setViewingUser(null); void onRefresh(); }}
        onChanged={() => void onRefresh()}
      />

      {editingUser && (
        <EditUserDialog
          open={!!editingUser}
          user={editingUser}
          projectId={projectId}
          onOpenChange={(o) => { if (!o) setEditingUser(null); }}
          onSaved={() => { setEditingUser(null); void onRefresh(); }}
        />
      )}

      {resetingUser && (
        <ResetPasswordDialog
          open={!!resetingUser}
          user={resetingUser}
          projectId={projectId}
          onOpenChange={(o) => { if (!o) setResetingUser(null); }}
          onDone={() => setResetingUser(null)}
        />
      )}
    </>
  );
}

/* ──────────────────────────────────────────── User Detail Drawer */
/**
 * A side panel built on the dialog primitive, so it stacks like every other
 * dialog: a confirmation opened from it appears above it, Esc closes the
 * topmost layer, and focus stays inside while it is open.
 */
function UserDetailDrawer({
  user,
  projectId,
  onClose,
  onEdit,
  onReset,
  onDeleted,
  onChanged,
}: {
  user: RealmUser | null;
  projectId: string;
  onClose: () => void;
  onEdit: () => void;
  onReset: () => void;
  onDeleted: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<RealmUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const userId = user?.id ?? null;
  // Set once the user is deleted, so nothing refetches a record that is gone.
  const deletedRef = useRef(false);

  const load = useCallback(async () => {
    if (!userId || deletedRef.current) return;
    setLoading(true);
    try {
      setDetail(await api.projects.realmUserDetail(projectId, userId));
    } catch (err: any) {
      toast.error(err.message || 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }, [projectId, userId]);

  useEffect(() => {
    deletedRef.current = false;
    setDetail(null);
    if (userId) void load();
  }, [userId, load]);

  async function act(fn: () => Promise<any>, ok: string, opts: { notify?: boolean } = {}) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await load();
      if (opts.notify) onChanged();
    }
    catch (err: any) { toast.error(err.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!user) return;
    if (!(await confirmDialog({ title: 'Delete user', description: `Delete user "${user.email}"? Their sessions end and the account cannot be restored.`, confirmText: 'Delete user', destructive: true }))) return;
    setBusy(true);
    try {
      await api.projects.deleteRealmUser(projectId, user.id);
      deletedRef.current = true;
      toast.success('User deleted');
      onDeleted();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const sessions = detail?.sessions || [];
  const mfaRequired = !!detail?.mfa?.enrollmentRequired;

  return (
    <DialogPrimitive.Root open={!!user} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
      <DialogOverlay className="bg-black/40" />
      <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 h-full w-full max-w-md overflow-y-auto border-l bg-background shadow-xl focus:outline-none">
        {user && (
          <>
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div className="min-w-0">
                <DialogTitle className="truncate text-base font-semibold">
                  {[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
                </DialogTitle>
                <DialogDescription className="truncate text-xs">{user.email}</DialogDescription>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close user details"><X className="h-4 w-4" /></Button>
            </div>

            {loading || !detail ? (
              <div className="flex h-40 items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : (
              <div className="space-y-6 p-5">
                {/* Overview */}
                <section className="space-y-2 text-sm">
                  <DetailRow label="User UID" value={
                    <button type="button" className="flex items-center gap-1 font-mono text-xs hover:text-foreground"
                      onClick={() => { navigator.clipboard.writeText(detail.id); toast.success('Copied'); }}>
                      {detail.id} <Copy className="h-3 w-3" />
                    </button>
                  } />
                  <DetailRow label="Email confirmed" value={detail.emailVerified
                    ? <span className="text-emerald-600 dark:text-emerald-400">Yes</span>
                    : <span className="text-amber-600 dark:text-amber-400">No</span>} />
                  <DetailRow label="Phone" value={detail.phoneNumber || '—'} />
                  {detail.phoneNumber && (
                    <DetailRow label="Phone verified" value={detail.phoneVerified
                      ? <span className="text-emerald-600 dark:text-emerald-400">Yes</span>
                      : <span className="text-amber-600 dark:text-amber-400">No</span>} />
                  )}
                  <DetailRow label="Status" value={detail.enabled ? 'Active' : 'Disabled'} />
                  <DetailRow label="MFA" value={
                    detail.mfa?.enrolled
                      ? <span className="text-emerald-600 dark:text-emerald-400">Enrolled</span>
                      : mfaRequired
                        ? <span className="text-amber-600 dark:text-amber-400">Required, not enrolled yet</span>
                        : 'Not required'
                  } />
                  <DetailRow label="Created" value={fmtTs(detail.createdTimestamp)} />
                  <DetailRow label="Last signed in" value={fmtTs(detail.lastSignIn)} />
                  <DetailRow label="Active sessions" value={String(detail.sessionCount)} />
                </section>

                {/* Providers */}
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Sign-in providers</h3>
                  <div className="flex flex-wrap gap-2">
                    {detail.providers.map((p) => (
                      <Badge key={p} variant="secondary" className="capitalize">{p}</Badge>
                    ))}
                  </div>
                </section>

                {/* Actions */}
                <section className="grid grid-cols-2 gap-2">
                  <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="mr-2 h-3.5 w-3.5" />Edit</Button>
                  <Button variant="outline" size="sm" onClick={onReset}><KeyRound className="mr-2 h-3.5 w-3.5" />Set password</Button>
                  <Button variant="outline" size="sm" disabled={busy}
                    onClick={() => act(() => api.projects.sendRealmUserRecovery(projectId, user.id), 'Recovery email sent')}>
                    <Mail className="mr-2 h-3.5 w-3.5" />Send recovery
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy}
                    onClick={() => act(() => api.projects.sendRealmUserVerification(projectId, user.id), 'Verification email sent')}>
                    <Mail className="mr-2 h-3.5 w-3.5" />Send verify
                  </Button>
                  {mfaRequired ? (
                    <Button variant="outline" size="sm" className="col-span-2" disabled={busy}
                      onClick={() => act(() => api.projects.requireRealmUserMfa(projectId, user.id, false), 'MFA requirement withdrawn', { notify: true })}>
                      <ShieldCheck className="mr-2 h-3.5 w-3.5" />Withdraw MFA requirement
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="col-span-2" disabled={busy}
                      onClick={() => act(() => api.projects.requireRealmUserMfa(projectId, user.id, true), 'User must set up MFA at next sign-in', { notify: true })}>
                      <ShieldCheck className="mr-2 h-3.5 w-3.5" />Require MFA enrollment
                    </Button>
                  )}
                </section>

                {/* Sessions */}
                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground">Sessions</h3>
                    {sessions.length > 0 && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" disabled={busy}
                        onClick={() => act(() => api.projects.logoutRealmUser(projectId, user.id), 'Signed out of all sessions')}>
                        <LogOut className="mr-1 h-3.5 w-3.5" />Sign out all
                      </Button>
                    )}
                  </div>
                  {sessions.length === 0 ? (
                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No active sessions</p>
                  ) : (
                    <div className="space-y-2">
                      {sessions.map((s: RealmSession) => (
                        <div key={s.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 font-medium">
                              <Globe className="h-3.5 w-3.5 text-muted-foreground" />{s.ipAddress || 'unknown IP'}
                              {s.location && <span className="font-normal text-muted-foreground">· {s.location}</span>}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                              <Monitor className="h-3 w-3" />
                              {(s.clients || []).join(', ') || '—'} · last {fmtTs(s.lastAccess)}
                            </div>
                          </div>
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" disabled={busy}
                            onClick={() => act(() => api.projects.revokeRealmUserSession(projectId, user.id, s.id), 'Session revoked')}>
                            Revoke
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Danger */}
                <section className="border-t pt-4">
                  <Button variant="destructive" size="sm" className="w-full" disabled={busy} onClick={() => void remove()}>
                    <Trash2 className="mr-2 h-3.5 w-3.5" />Delete user
                  </Button>
                </section>
              </div>
            )}
          </>
        )}
      </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────── Sessions Tab */
function SessionsTab({ projectId }: { projectId: string }) {
  const [sessions, setSessions] = useState<RealmSessionFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSessions(await api.projects.realmSessions(projectId)); }
    catch (err: any) { toast.error(err.message); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function revoke(id: string) {
    setBusy(true);
    try { await api.projects.revokeRealmSession(projectId, id); toast.success('Session revoked'); await load(); }
    catch (err: any) { toast.error(err.message); }
    finally { setBusy(false); }
  }

  if (loading) {
    return <div className="flex h-32 items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{sessions.length} active session{sessions.length === 1 ? '' : 's'} across all users</p>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh</Button>
      </div>
      {sessions.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed">
          <Monitor className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">No active sessions</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">User</th>
                <th className="px-4 py-2 text-left font-medium">IP</th>
                <th className="px-4 py-2 text-left font-medium">Location</th>
                <th className="px-4 py-2 text-left font-medium">Clients</th>
                <th className="px-4 py-2 text-left font-medium">Started</th>
                <th className="px-4 py-2 text-left font-medium">Last access</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{s.username || s.userId || '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{s.ipAddress || '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{s.location || '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{(s.clients || []).join(', ') || '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{fmtTs(s.start)}</td>
                  <td className="px-4 py-2 text-muted-foreground">{fmtTs(s.lastAccess)}</td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" disabled={busy} onClick={() => revoke(s.id)}>Revoke</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────── MFA Tab */
function MfaTab({ projectId }: { projectId: string }) {
  const [users, setUsers] = useState<MfaUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers(await api.projects.realmMfaUsers(projectId)); }
    catch (err: any) { toast.error(err.message); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function removeFactor(userId: string, credentialId: string, email: string, source?: string) {
    if (!(await confirmDialog({ title: 'Reset MFA', description: `Remove this MFA factor for "${email}"? They will need to re-enroll.`, destructive: true }))) return;
    setBusy(true);
    try {
      if (source === 'basefyio') await api.projects.removeRealmUserAppMfa(projectId, userId);
      else await api.projects.removeRealmUserMfa(projectId, userId, credentialId);
      toast.success('MFA factor removed');
      await load();
    }
    catch (err: any) { toast.error(err.message); }
    finally { setBusy(false); }
  }

  if (loading) {
    return <div className="flex h-32 items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
        <Info className="h-4 w-4 shrink-0" />
        <p>Users with an enrolled MFA factor: authenticator apps enrolled through the SDK (client.auth.enrollMfa) and factors set up in the hosted login (authenticator app / security key). Removing a factor forces re-enrollment on next login.</p>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{users.length} user{users.length === 1 ? '' : 's'} with MFA</p>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh</Button>
      </div>
      {users.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed">
          <ShieldCheck className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">No users have MFA enrolled</p>
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((u) => (
            <div key={u.id} className="rounded-lg border p-4">
              <div className="mb-2 font-medium">{u.email} <span className="text-xs text-muted-foreground">{[u.firstName, u.lastName].filter(Boolean).join(' ')}</span></div>
              <div className="space-y-2">
                {u.factors.map((f) => (
                  <div key={f.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="uppercase">{f.type}</Badge>
                      <Badge variant="outline" className="text-[10px]">{f.source === 'basefyio' ? 'SDK' : 'Hosted login'}</Badge>
                      <span className="text-muted-foreground">{f.userLabel || ''} {f.createdDate ? `· enrolled ${fmtDateOnly(f.createdDate)}` : ''}</span>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" disabled={busy} onClick={() => removeFactor(u.id, f.id, u.email, f.source)}>Remove</Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────── Policies Tab */
type PolicyForm = {
  bruteForceProtected: boolean;
  permanentLockout: boolean;
  failureFactor: string;
  waitIncrementSeconds: string;
  maxFailureWaitSeconds: string;
  accessTokenLifespanSeconds: string;
  minLength: string;
  historyCount: string;
  expiryDays: string;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigits: boolean;
  requireSpecial: boolean;
};

function policyForm(p: RealmPolicies): PolicyForm {
  return {
    bruteForceProtected: p.bruteForceProtected,
    permanentLockout: p.permanentLockout,
    failureFactor: String(p.failureFactor),
    waitIncrementSeconds: String(p.waitIncrementSeconds),
    maxFailureWaitSeconds: String(p.maxFailureWaitSeconds),
    accessTokenLifespanSeconds: String(p.accessTokenLifespanSeconds ?? 1800),
    minLength: String(p.password.minLength),
    historyCount: String(p.password.historyCount),
    expiryDays: String(p.password.expiryDays),
    requireUppercase: p.password.requireUppercase,
    requireLowercase: p.password.requireLowercase,
    requireDigits: p.password.requireDigits,
    requireSpecial: p.password.requireSpecial,
  };
}

/** Field → message for every value the server would refuse; empty when the form can be saved. */
function policyErrors(f: PolicyForm): Partial<Record<keyof PolicyForm, string>> {
  const e: Partial<Record<keyof PolicyForm, string>> = {};
  const check = (k: keyof PolicyForm, label: string, bounds: { min: number; max: number }) => {
    const msg = rangeError(f[k] as string, label, bounds);
    if (msg) e[k] = msg;
  };
  check('minLength', 'Minimum length', PASSWORD_MIN_LENGTH_BOUNDS);
  check('historyCount', 'Password history', POLICY_BOUNDS.historyCount);
  check('expiryDays', 'Expiry', POLICY_BOUNDS.expiryDays);
  check('accessTokenLifespanSeconds', 'Token lifetime', TOKEN_LIFESPAN_BOUNDS);
  if (f.bruteForceProtected) {
    check('failureFactor', 'Max login failures', POLICY_BOUNDS.failureFactor);
    check('waitIncrementSeconds', 'Wait increment', POLICY_BOUNDS.waitIncrementSeconds);
    check('maxFailureWaitSeconds', 'Max wait', POLICY_BOUNDS.maxFailureWaitSeconds);
    if (!e.waitIncrementSeconds && !e.maxFailureWaitSeconds && Number(f.maxFailureWaitSeconds) < Number(f.waitIncrementSeconds)) {
      e.maxFailureWaitSeconds = 'Max wait must be at least the wait increment';
    }
  }
  return e;
}

function PoliciesTab({ projectId }: { projectId: string }) {
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.projects.getAuthPolicies(projectId)
      .then((p) => setForm(policyForm(p)))
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading || !form) {
    return <div className="flex h-32 items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>;
  }

  const errors = policyErrors(form);
  const invalid = Object.keys(errors).length > 0;
  const set = (patch: Partial<PolicyForm>) => setForm({ ...form, ...patch });

  async function save() {
    if (!form || invalid) return;
    setSaving(true);
    try {
      const updated = await api.projects.updateAuthPolicies(projectId, {
        bruteForceProtected: form.bruteForceProtected,
        ...(form.bruteForceProtected
          ? {
              permanentLockout: form.permanentLockout,
              failureFactor: Number(form.failureFactor),
              waitIncrementSeconds: Number(form.waitIncrementSeconds),
              maxFailureWaitSeconds: Number(form.maxFailureWaitSeconds),
            }
          : {}),
        accessTokenLifespanSeconds: Number(form.accessTokenLifespanSeconds),
        password: {
          minLength: Number(form.minLength),
          historyCount: Number(form.historyCount),
          expiryDays: Number(form.expiryDays),
          requireUppercase: form.requireUppercase,
          requireLowercase: form.requireLowercase,
          requireDigits: form.requireDigits,
          requireSpecial: form.requireSpecial,
        },
      });
      setForm(policyForm(updated));
      toast.success('Policies saved');
    } catch (err: any) { toast.error(err.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-6">
      {/* Brute force */}
      <div className="rounded-lg border p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Brute-force protection</h3>
            <p className="text-xs text-muted-foreground">Temporarily lock an account after repeated failed sign-ins. Only failures count.</p>
          </div>
          <Toggle checked={form.bruteForceProtected} onChange={(v) => set({ bruteForceProtected: v })} label="Brute-force protection" />
        </div>
        {!form.bruteForceProtected && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>Recommended: turn this on. Without it, passwords can be guessed with unlimited attempts. New projects start with it on (10 failures, a lockout growing from 1 to 15 minutes).</p>
          </div>
        )}
        {form.bruteForceProtected && (
          <div className="grid gap-4 sm:grid-cols-2">
            <NumField label="Max login failures" value={form.failureFactor} error={errors.failureFactor} hint={`${POLICY_BOUNDS.failureFactor.min}–${POLICY_BOUNDS.failureFactor.max}`} onChange={(v) => set({ failureFactor: v })} />
            <NumField label="Wait increment (seconds)" value={form.waitIncrementSeconds} error={errors.waitIncrementSeconds} onChange={(v) => set({ waitIncrementSeconds: v })} />
            <NumField label="Max wait (seconds)" value={form.maxFailureWaitSeconds} error={errors.maxFailureWaitSeconds} onChange={(v) => set({ maxFailureWaitSeconds: v })} />
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm">Permanent lockout</span>
              <Toggle checked={form.permanentLockout} onChange={(v) => set({ permanentLockout: v })} label="Permanent lockout" />
            </div>
          </div>
        )}
      </div>

      {/* Password policy */}
      <div className="rounded-lg border p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Password policy</h3>
          <p className="text-xs text-muted-foreground">
            The one place password rules are set. They apply to SDK sign-up, password resets and users you add here.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumField label="Minimum length" value={form.minLength} error={errors.minLength} hint={`${PASSWORD_MIN_LENGTH_BOUNDS.min}–${PASSWORD_MIN_LENGTH_BOUNDS.max} characters`} onChange={(v) => set({ minLength: v })} />
          <NumField label="Password history (remembered)" value={form.historyCount} error={errors.historyCount} hint="0 = off" onChange={(v) => set({ historyCount: v })} />
          <NumField label="Expiry (days)" value={form.expiryDays} error={errors.expiryDays} hint="0 = never" onChange={(v) => set({ expiryDays: v })} />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <CheckRow label="Require uppercase letter" checked={form.requireUppercase} onChange={(v) => set({ requireUppercase: v })} />
          <CheckRow label="Require lowercase letter" checked={form.requireLowercase} onChange={(v) => set({ requireLowercase: v })} />
          <CheckRow label="Require digit" checked={form.requireDigits} onChange={(v) => set({ requireDigits: v })} />
          <CheckRow label="Require special character" checked={form.requireSpecial} onChange={(v) => set({ requireSpecial: v })} />
        </div>
      </div>

      {/* Sessions */}
      <div className="rounded-lg border p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Sessions</h3>
          <p className="text-xs text-muted-foreground">
            How long an access token stays valid. The SDK refreshes it automatically before it expires.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumField
            label="Access token lifetime (seconds)"
            value={form.accessTokenLifespanSeconds}
            error={errors.accessTokenLifespanSeconds}
            hint={`${TOKEN_LIFESPAN_BOUNDS.min}–${TOKEN_LIFESPAN_BOUNDS.max} (5 minutes to 24 hours)`}
            onChange={(v) => set({ accessTokenLifespanSeconds: v })}
          />
        </div>
      </div>

      <Button onClick={save} disabled={saving || invalid}>{saving ? 'Saving…' : 'Save policies'}</Button>
      {invalid && <p className="text-xs text-destructive">Fix the highlighted fields to save.</p>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${checked ? 'bg-primary' : 'bg-input'}`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

function NumField({
  label,
  value,
  onChange,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
}) {
  const id = `num-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        className={error ? 'border-destructive focus-visible:ring-destructive' : undefined}
      />
      {(error || hint) && (
        <p id={`${id}-msg`} className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{error || hint}</p>
      )}
    </div>
  );
}

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
    </label>
  );
}

/* ────────────────────────────────────────────────────── Providers Tab */
type ProviderId =
  | 'google'
  | 'microsoft'
  | 'apple'
  | 'github'
  | 'gitlab'
  | 'linkedin'
  | 'facebook'
  | 'twitter';

const PROVIDER_DEFS: { id: ProviderId; label: string; iconText: string }[] = [
  { id: 'google', label: 'Google', iconText: 'G' },
  { id: 'microsoft', label: 'Microsoft', iconText: 'M' },
  { id: 'apple', label: 'Apple', iconText: 'A' },
  { id: 'github', label: 'GitHub', iconText: 'GH' },
  { id: 'gitlab', label: 'GitLab', iconText: 'GL' },
  { id: 'linkedin', label: 'LinkedIn', iconText: 'in' },
  { id: 'facebook', label: 'Facebook', iconText: 'f' },
  { id: 'twitter', label: 'Twitter', iconText: 'X' },
];

function ProviderLogo({ provider }: { provider: ProviderId }) {
  if (provider === 'google') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.5 14.7 2.5 12 2.5 6.8 2.5 2.5 6.8 2.5 12s4.3 9.5 9.5 9.5c5.5 0 9.1-3.9 9.1-9.3 0-.6-.1-1.1-.2-1.6H12z"/>
      </svg>
    );
  }
  if (provider === 'microsoft') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <rect x="2" y="2" width="9" height="9" fill="#F25022" />
        <rect x="13" y="2" width="9" height="9" fill="#7FBA00" />
        <rect x="2" y="13" width="9" height="9" fill="#00A4EF" />
        <rect x="13" y="13" width="9" height="9" fill="#FFB900" />
      </svg>
    );
  }
  if (provider === 'apple') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-foreground" aria-hidden="true">
        <path d="M16.7 12.8c0-2 1.6-3 1.7-3.1-1-1.4-2.4-1.6-2.9-1.7-1.2-.1-2.3.7-2.9.7-.6 0-1.4-.7-2.4-.7-1.2 0-2.3.7-2.9 1.7-1.3 2.1-.3 5.3.9 7 .6.8 1.3 1.7 2.2 1.6.9 0 1.2-.6 2.3-.6s1.4.6 2.3.6c1 0 1.6-.8 2.2-1.6.7-1 1-1.9 1-1.9-.1 0-1.6-.6-1.6-2zM14.8 6.8c.5-.6.9-1.4.8-2.3-.7 0-1.6.5-2.1 1-.5.6-.9 1.4-.8 2.2.8.1 1.6-.4 2.1-.9z" />
      </svg>
    );
  }
  if (provider === 'github') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-foreground" aria-hidden="true">
        <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.2-3.5-1.2-.5-1.2-1.2-1.5-1.2-1.5-1-.7.1-.7.1-.7 1 .1 1.6 1.1 1.6 1.1 1 .1 1.8-.7 2.2-1-.8-.1-1.6-.4-2.2-1-.5-.5-.9-1.3-.9-2.7 0-1 .3-1.8.9-2.4-.1-.2-.4-1.1.1-2.3 0 0 .8-.3 2.5 1a8.5 8.5 0 0 1 4.6 0c1.7-1.3 2.5-1 2.5-1 .5 1.2.2 2.1.1 2.3.6.6.9 1.3.9 2.4 0 1.4-.5 2.2-1 2.7-.6.6-1.4.9-2.2 1v2.6c0 .2.2.6.7.5A10 10 0 0 0 12 2z" />
      </svg>
    );
  }
  if (provider === 'gitlab') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path fill="#FC6D26" d="M12 21.5l3.7-11.3H8.3L12 21.5z" />
        <path fill="#E24329" d="M12 21.5L8.3 10.2H3.1L12 21.5z" />
        <path fill="#FC6D26" d="M3.1 10.2l-1.1 3.3c-.1.2 0 .4.1.5L12 21.5 3.1 10.2z" />
        <path fill="#FCA326" d="M3.1 10.2h5.2L6 3.2c-.1-.3-.5-.3-.6 0l-2.3 7z" />
        <path fill="#E24329" d="M12 21.5l3.7-11.3h5.2L12 21.5z" />
        <path fill="#FC6D26" d="M20.9 10.2l1.1 3.3c.1.2 0 .4-.1.5L12 21.5l8.9-11.3z" />
        <path fill="#FCA326" d="M20.9 10.2h-5.2L18 3.2c.1-.3.5-.3.6 0l2.3 7z" />
      </svg>
    );
  }
  if (provider === 'linkedin') {
    return (
      <div className="flex h-5 w-5 items-center justify-center rounded-sm bg-[#0A66C2] text-[10px] font-bold text-white">
        in
      </div>
    );
  }
  if (provider === 'facebook') {
    return (
      <div className="flex h-5 w-5 items-center justify-center rounded-sm bg-[#1877F2] text-xs font-bold text-white">
        f
      </div>
    );
  }
  return (
    <div className="flex h-5 w-5 items-center justify-center rounded-sm bg-black text-[10px] font-bold text-white dark:bg-white dark:text-black">
      X
    </div>
  );
}

function ProvidersTab({
  projectId,
  config,
  onSaved,
}: {
  projectId: string;
  config: ProjectAuthConfig;
  onSaved: (c: ProjectAuthConfig) => void;
}) {
  const [callbackUrls, setCallbackUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.projects.getProviders(projectId).then((data) => {
      setCallbackUrls(data.callbackUrls);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
        <Info className="h-4 w-4 shrink-0" />
        <p>Configure sign-in providers for your app. Users can sign in with enabled providers via basefyio Auth SDK.</p>
      </div>

      <RedirectUrlsCard projectId={projectId} config={config} onSaved={onSaved} />

      {PROVIDER_DEFS.map((p) => (
        <ProviderCard
          key={p.id}
          projectId={projectId}
          provider={p.id}
          label={p.label}
          icon={<ProviderLogo provider={p.id} />}
          enabled={Boolean((config as any)[`${p.id}Enabled`])}
          clientId={String((config as any)[`${p.id}ClientId`] || '')}
          hasSecret={Boolean((config as any)[`${p.id}ClientSecret`])}
          callbackUrl={callbackUrls[p.id] || ''}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

function RedirectUrlsCard({
  projectId,
  config,
  onSaved,
}: {
  projectId: string;
  config: ProjectAuthConfig;
  onSaved: (c: ProjectAuthConfig) => void;
}) {
  const [urls, setUrls] = useState<string[]>(config.redirectUrls ?? []);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(next: string[]) {
    setSaving(true);
    try {
      const updated = await api.projects.updateAuthConfig(projectId, { redirectUrls: next });
      setUrls(updated.redirectUrls ?? next);
      onSaved(updated);
      toast.success('Redirect URLs saved');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  function add() {
    let value = draft.trim();
    while (value.endsWith('/')) value = value.slice(0, -1);
    if (!value) return;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
    } catch {
      toast.error('Enter a full http(s) URL, e.g. https://app.example.com/auth/callback');
      return;
    }
    if (urls.includes(value)) {
      setDraft('');
      return;
    }
    setDraft('');
    void save([...urls, value]);
  }

  return (
    <div className="rounded-lg border p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Globe className="h-5 w-5 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">Redirect URLs</h3>
          <p className="text-xs text-muted-foreground">
            Where a social sign-in may send the browser back to. Pass one as
            <code className="mx-1 font-mono">redirect_to</code>
            and the tokens arrive in that URL&apos;s fragment.
          </p>
        </div>
      </div>

      {urls.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None yet — without one, sign-in can only return to a path on the API host,
          which is no use to an app on its own domain.
        </p>
      ) : (
        <ul className="space-y-2">
          {urls.map((url) => (
            <li key={url} className="flex items-center gap-2">
              <Input value={url} readOnly className="font-mono text-xs bg-muted" />
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                disabled={saving}
                onClick={() => void save(urls.filter((u) => u !== url))}
                aria-label={`Remove ${url}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="https://app.example.com/auth/callback"
          className="font-mono text-xs"
        />
        <Button variant="outline" className="shrink-0" disabled={saving} onClick={add}>
          <Plus className="mr-1 h-4 w-4" /> Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A URL also covers the paths under it, so
        <code className="mx-1 font-mono">https://app.example.com</code>
        allows any callback on that origin. Anything not listed falls back to the API host.
      </p>
    </div>
  );
}

function ProviderCard({
  projectId,
  provider,
  label,
  icon,
  enabled,
  clientId: initialClientId,
  hasSecret,
  callbackUrl,
  onSaved,
}: {
  projectId: string;
  provider: ProviderId;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
  clientId: string;
  hasSecret: boolean;
  callbackUrl: string;
  onSaved: (c: ProjectAuthConfig) => void;
}) {
  const [isEnabled, setIsEnabled] = useState(enabled);
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const payload: { clientId: string; clientSecret?: string; enabled: boolean } = {
        clientId,
        enabled: isEnabled,
      };
      if (clientSecret) payload.clientSecret = clientSecret;
      const updated = await api.projects.saveProvider(projectId, provider, payload);
      onSaved(updated);
      setClientSecret('');
      toast.success(`${label} provider ${isEnabled ? 'enabled' : 'disabled'}`);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  function copyCallback() {
    navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {icon}
          <div>
            <h3 className="text-sm font-semibold">{label}</h3>
            <p className="text-xs text-muted-foreground">Allow users to sign in with {label}</p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isEnabled}
          onClick={() => setIsEnabled(!isEnabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
            isEnabled ? 'bg-primary' : 'bg-input'
          }`}
        >
          <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${isEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
      </div>

      {isEnabled && (
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label>Callback URL</Label>
            <div className="flex gap-2">
              <Input value={callbackUrl} readOnly className="font-mono text-xs bg-muted" />
              <Button variant="outline" size="icon" className="shrink-0" onClick={copyCallback}>
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Add this URL to your {label} OAuth app&apos;s authorized redirect URIs.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Client ID</Label>
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={`${label} Client ID`}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Client Secret</Label>
              <Input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={hasSecret ? '••••••••  (saved)' : 'Enter client secret'}
              />
            </div>
          </div>

          <Button onClick={handleSave} disabled={saving || !clientId}>
            {saving ? 'Saving...' : `Save ${label} Settings`}
          </Button>
        </div>
      )}

      {!isEnabled && enabled && (
        <div className="pt-2">
          <Button variant="outline" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : `Disable ${label}`}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────── Settings Tab */
function SettingsTab({
  projectId,
  config,
  onSaved,
  onOpenPolicies,
}: {
  projectId: string;
  config: ProjectAuthConfig;
  onSaved: (c: ProjectAuthConfig) => void;
  onOpenPolicies: () => void;
}) {
  const [selfSignup, setSelfSignup] = useState(config.allowSignup);
  const [emailVerification, setEmailVerification] = useState(config.requireEmailVerify);
  const [allowAnonymous, setAllowAnonymous] = useState(config.allowAnonymous ?? false);
  const [enforceMfa, setEnforceMfa] = useState(config.mfaEnforceEnrollment ?? false);
  const [saving, setSaving] = useState(false);

  // Only what changed is sent, so this tab never writes back a value another
  // tab (or another person) saved in the meantime.
  const changes: Partial<ProjectAuthConfig> = {};
  if (selfSignup !== config.allowSignup) changes.allowSignup = selfSignup;
  if (emailVerification !== config.requireEmailVerify) changes.requireEmailVerify = emailVerification;
  if (allowAnonymous !== (config.allowAnonymous ?? false)) changes.allowAnonymous = allowAnonymous;
  if (enforceMfa !== (config.mfaEnforceEnrollment ?? false)) changes.mfaEnforceEnrollment = enforceMfa;
  const dirty = Object.keys(changes).length > 0;

  async function handleSave() {
    if (!dirty) return;
    setSaving(true);
    try {
      const updated = await api.projects.updateAuthConfig(projectId, changes);
      onSaved(updated);
      toast.success('Settings saved');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          Registration
        </h3>
        <ToggleSetting
          label="Allow self-signup"
          description="Users can create accounts via SDK (client.auth.signUp)"
          checked={selfSignup}
          onChange={setSelfSignup}
        />
        <ToggleSetting
          label="Allow anonymous sign-in"
          description="client.auth.signInAnonymously() creates a temporary user whose tokens carry is_anonymous: true (readable in policies through auth.jwt()). It can be turned into a real account later with upgradeAnonymous(), keeping the same user id. Off by default."
          checked={allowAnonymous}
          onChange={setAllowAnonymous}
        />
      </div>

      <div className="rounded-lg border p-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Multi-factor authentication
        </h3>
        <ToggleSetting
          label="Enforce MFA enrollment at sign-in"
          description="Users you marked with “Require MFA enrollment” get no session until they enroll an authenticator app through the SDK (an enrollment challenge is returned instead). Off: they sign in and the response carries mfaEnrollmentRequired for your app to prompt."
          checked={enforceMfa}
          onChange={setEnforceMfa}
        />
      </div>

      <div className="rounded-lg border p-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Email Verification
        </h3>
        <ToggleSetting
          label="Require email verification"
          description="Send a 6-digit OTP code when users sign up. Users can still authenticate but emailVerified will be false until verified."
          checked={emailVerification}
          onChange={setEmailVerification}
        />
      </div>

      <div className="flex items-start gap-3 rounded-lg border p-4 text-sm">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">
          Password rules, brute-force protection and the access-token lifetime are set in one place:{' '}
          <button type="button" onClick={onOpenPolicies} className="font-medium text-primary underline-offset-2 hover:underline">
            Policies
          </button>
          .
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
        <Info className="h-4 w-4 shrink-0" />
        <p>Settings are saved per-project. Changes will take effect immediately for new auth requests.</p>
      </div>

      <Button onClick={handleSave} disabled={saving || !dirty}>
        {saving ? 'Saving...' : dirty ? 'Save Settings' : 'No changes'}
      </Button>
    </div>
  );
}

/* ────────────────────────────────────────────────────── Email Tab */
function EmailTab({
  projectId,
  config,
  onSaved,
}: {
  projectId: string;
  config: ProjectAuthConfig;
  onSaved: (c: ProjectAuthConfig) => void;
}) {
  // A host saved without a provider (older configs) is still sent through SMTP,
  // so show it as Custom SMTP rather than as the platform default.
  const savedProvider = config.emailProvider || (config.smtpHost ? 'smtp' : '');
  const [provider, setProvider] = useState(savedProvider);
  const [smtpHost, setSmtpHost] = useState(config.smtpHost || '');
  const [smtpPort, setSmtpPort] = useState(String(config.smtpPort || 587));
  const [smtpUser, setSmtpUser] = useState(config.smtpUser || '');
  const [smtpPass, setSmtpPass] = useState('');
  const [senderEmail, setSenderEmail] = useState(config.senderEmail || '');
  const [senderName, setSenderName] = useState(config.senderName || '');
  const [resendApiKey, setResendApiKey] = useState('');
  const [sendgridApiKey, setSendgridApiKey] = useState('');
  const [sesAccessKey, setSesAccessKey] = useState('');
  const [sesSecretKey, setSesSecretKey] = useState('');
  const [sesRegion, setSesRegion] = useState(config.sesRegion || 'us-east-1');
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  /** Required fields for the chosen provider; a saved secret counts as filled. */
  const providerErrors: Record<string, string> = {};
  if (provider) {
    if (!senderEmail.trim()) providerErrors.senderEmail = 'Sender email is required with your own provider';
    else if (!isValidEmail(senderEmail)) providerErrors.senderEmail = 'Enter a valid email address';
  }
  if (provider === 'smtp') {
    if (!smtpHost.trim()) providerErrors.smtpHost = 'SMTP host is required';
    else if (/\s|\/|:/.test(smtpHost.trim())) providerErrors.smtpHost = 'Enter a host name such as smtp.example.com';
    const portErr = rangeError(smtpPort, 'Port', { min: 1, max: 65535 });
    if (portErr) providerErrors.smtpPort = portErr;
    if (!smtpUser.trim()) providerErrors.smtpUser = 'Username is required';
    if (!smtpPass && !config.smtpPass) providerErrors.smtpPass = 'Password is required';
  }
  if (provider === 'resend' && !resendApiKey && !config.resendApiKey) providerErrors.resendApiKey = 'API key is required';
  if (provider === 'sendgrid' && !sendgridApiKey && !config.sendgridApiKey) providerErrors.sendgridApiKey = 'API key is required';
  if (provider === 'ses') {
    if (!sesAccessKey && !config.sesAccessKey) providerErrors.sesAccessKey = 'Access key is required';
    if (!sesSecretKey && !config.sesSecretKey) providerErrors.sesSecretKey = 'Secret key is required';
  }
  const providerInvalid = Object.keys(providerErrors).length > 0;
  const fieldError = (k: string) => (showErrors ? providerErrors[k] : undefined);

  /** The provider part of the form, as the API expects it. */
  function providerPayload(): Record<string, any> {
    const payload: Record<string, any> = { emailProvider: provider || null };
    if (!provider) {
      payload.senderEmail = null;
      payload.senderName = null;
      return payload;
    }
    payload.senderEmail = senderEmail.trim() || null;
    payload.senderName = senderName.trim() || null;
    if (provider === 'smtp') {
      payload.smtpHost = smtpHost.trim() || null;
      payload.smtpPort = parseInt(smtpPort, 10);
      payload.smtpUser = smtpUser.trim() || null;
      if (smtpPass) payload.smtpPass = smtpPass;
    }
    if (provider === 'resend' && resendApiKey) payload.resendApiKey = resendApiKey;
    if (provider === 'sendgrid' && sendgridApiKey) payload.sendgridApiKey = sendgridApiKey;
    if (provider === 'ses') {
      if (sesAccessKey) payload.sesAccessKey = sesAccessKey;
      if (sesSecretKey) payload.sesSecretKey = sesSecretKey;
      payload.sesRegion = sesRegion;
    }
    return payload;
  }

  async function saveProvider() {
    if (providerInvalid) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.projects.updateAuthConfig(projectId, providerPayload());
      onSaved(updated);
      setSmtpPass(''); setResendApiKey(''); setSendgridApiKey('');
      setSesAccessKey(''); setSesSecretKey('');
      setShowErrors(false);
      toast.success(provider ? 'Email provider settings saved' : 'Emails now go out through the platform email service');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (providerInvalid) {
      setShowErrors(true);
      return;
    }
    if (testTo.trim() && !isValidEmail(testTo)) {
      setTestResult({ ok: false, message: 'Enter a valid recipient address, or leave it empty to use your own.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.projects.testAuthEmail(projectId, {
        to: testTo.trim() || undefined,
        settings: providerPayload(),
      });
      setTestResult(
        res.ok
          ? { ok: true, message: `Test email sent to ${res.to}. Check the inbox (and the spam folder).` }
          : { ok: false, message: res.error || 'The test email could not be sent.' },
      );
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message || 'The test email could not be sent.' });
    } finally {
      setTesting(false);
    }
  }

  const [editingTemplate, setEditingTemplate] = useState<{
    key: string;
    label: string;
  } | null>(null);

  type TemplateKey = 'verify' | 'reset' | 'welcome' | 'invite' | 'magic_link' | 'change_email' | 'reauth';
  type SubjectField = keyof ProjectAuthConfig & `${string}Subject`;
  type BodyField = keyof ProjectAuthConfig & `${string}Body`;

  const templates: {
    key: TemplateKey;
    name: string;
    description: string;
    subjectField: SubjectField;
    bodyField: BodyField;
    defaultSubject: string;
    defaultBody: string;
    variables: string[];
  }[] = [
    {
      key: 'verify',
      name: 'Confirm Sign Up',
      description: 'Sent when a user signs up to confirm their email address.',
      subjectField: 'verifyEmailSubject',
      bodyField: 'verifyEmailBody',
      defaultSubject: '[{{project_name}}] Verify your email',
      defaultBody: `<h2>Verify your email</h2>
<p>You signed up for <strong>{{project_name}}</strong>. Your verification code is:</p>
<h1 style="letter-spacing:6px;text-align:center;color:#2563eb;font-family:monospace;">{{otp}}</h1>
<p style="text-align:center;font-size:13px;color:#94a3b8;">Or <a href="{{verify_url}}">click here</a> to verify directly.</p>
<p style="font-size:13px;color:#94a3b8;">This code expires in 24 hours.</p>`,
      variables: ['{{otp}}', '{{project_name}}', '{{verify_url}}', '{{email}}'],
    },
    {
      key: 'invite',
      name: 'Invite User',
      description: 'Invite users who don\'t yet have an account to sign up.',
      subjectField: 'inviteUserSubject',
      bodyField: 'inviteUserBody',
      defaultSubject: "You've been invited to {{project_name}}",
      defaultBody: `<h2>You've been invited!</h2>
<p>You've been invited to join <strong>{{project_name}}</strong>. Click the button below to create your account.</p>
<p style="text-align:center;"><a href="{{invite_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:600;">Accept Invitation</a></p>
<p style="font-size:13px;color:#94a3b8;">If you weren't expecting this, you can safely ignore this email.</p>`,
      variables: ['{{project_name}}', '{{invite_url}}', '{{email}}'],
    },
    {
      key: 'magic_link',
      name: 'Magic Link',
      description: 'Allow users to sign in via a one-time link sent to their email.',
      subjectField: 'magicLinkSubject',
      bodyField: 'magicLinkBody',
      defaultSubject: 'Sign in to {{project_name}}',
      defaultBody: `<h2>Sign in to {{project_name}}</h2>
<p>Click the button below to sign in. No password needed!</p>
<p style="text-align:center;"><a href="{{magic_link_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:600;">Sign In</a></p>
<h1 style="letter-spacing:6px;text-align:center;color:#2563eb;font-family:monospace;">{{otp}}</h1>
<p style="font-size:13px;color:#94a3b8;">This link expires in 10 minutes.</p>`,
      variables: ['{{otp}}', '{{project_name}}', '{{magic_link_url}}', '{{email}}'],
    },
    {
      key: 'change_email',
      name: 'Change Email Address',
      description: 'Ask users to verify their new email address after changing it.',
      subjectField: 'changeEmailSubject',
      bodyField: 'changeEmailBody',
      defaultSubject: '[{{project_name}}] Confirm your new email',
      defaultBody: `<h2>Confirm your new email</h2>
<p>You requested to change your email on <strong>{{project_name}}</strong> to <strong>{{new_email}}</strong>.</p>
<h1 style="letter-spacing:6px;text-align:center;color:#2563eb;font-family:monospace;">{{otp}}</h1>
<p style="text-align:center;"><a href="{{confirm_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 36px;border-radius:10px;text-decoration:none;font-weight:600;">Confirm Email Change</a></p>
<p style="font-size:13px;color:#94a3b8;">This code expires in 1 hour.</p>`,
      variables: ['{{otp}}', '{{project_name}}', '{{confirm_url}}', '{{email}}', '{{new_email}}'],
    },
    {
      key: 'reset',
      name: 'Reset Password',
      description: 'Allow users to reset their password if they forget it.',
      subjectField: 'resetPasswordSubject',
      bodyField: 'resetPasswordBody',
      defaultSubject: '[{{project_name}}] Reset your password',
      defaultBody: `<h2>Reset your password</h2>
<p>We received a password reset request for your <strong>{{project_name}}</strong> account ({{email}}).</p>
<h1 style="letter-spacing:6px;text-align:center;color:#2563eb;font-family:monospace;">{{otp}}</h1>
<p style="font-size:13px;color:#94a3b8;">Enter this code in the app to set a new password. This code expires in 1 hour.</p>`,
      variables: ['{{otp}}', '{{project_name}}', '{{email}}'],
    },
    {
      key: 'reauth',
      name: 'Reauthentication',
      description: 'Ask users to re-authenticate before performing a sensitive action.',
      subjectField: 'reauthSubject',
      bodyField: 'reauthBody',
      defaultSubject: '[{{project_name}}] Confirm your identity',
      defaultBody: `<h2>Confirm your identity</h2>
<p>A sensitive action was requested on your <strong>{{project_name}}</strong> account ({{email}}).</p>
<h1 style="letter-spacing:6px;text-align:center;color:#2563eb;font-family:monospace;">{{otp}}</h1>
<p style="font-size:13px;color:#94a3b8;">This code expires in 10 minutes. If you didn't initiate this, secure your account immediately.</p>`,
      variables: ['{{otp}}', '{{project_name}}', '{{email}}'],
    },
    {
      key: 'welcome',
      name: 'Welcome Email',
      description: 'Sent after email verification is completed.',
      subjectField: 'welcomeSubject',
      bodyField: 'welcomeBody',
      defaultSubject: 'Welcome to {{project_name}}!',
      defaultBody: `<h2>Welcome to {{project_name}}!</h2>
<p>Your email has been verified and your account is now fully active.</p>
<p>You can start using <strong>{{project_name}}</strong> right away.</p>
<p style="font-size:13px;color:#94a3b8;">If you have any questions, reach out to the {{project_name}} team.</p>`,
      variables: ['{{project_name}}', '{{email}}'],
    },
  ];

  return (
    <div className="space-y-6">
      {/* Email Provider */}
      <div className="rounded-lg border p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Server className="h-4 w-4 text-muted-foreground" />
            Email Provider
          </h3>
          <Badge variant="secondary">Optional</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          By default, emails are sent via basefyio&apos;s built-in email service.
          Configure a custom provider to send emails from your own domain.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="email-provider">Provider</Label>
          <select
            id="email-provider"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={provider}
            onChange={(e) => { setProvider(e.target.value); setTestResult(null); }}
          >
            <option value="">Platform Default (basefyio)</option>
            <option value="smtp">Custom SMTP</option>
            <option value="resend">Resend</option>
            <option value="sendgrid">SendGrid</option>
            <option value="ses">Amazon SES</option>
          </select>
        </div>

        {provider === 'smtp' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="smtp-host" label="SMTP Host *" error={fieldError('smtpHost')}>
              <Input id="smtp-host" placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} aria-invalid={!!fieldError('smtpHost')} />
            </FormField>
            <FormField id="smtp-port" label="SMTP Port *" error={fieldError('smtpPort')} hint="587 (STARTTLS) or 465 (TLS)">
              <Input id="smtp-port" inputMode="numeric" placeholder="587" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} aria-invalid={!!fieldError('smtpPort')} />
            </FormField>
            <FormField id="smtp-user" label="Username *" error={fieldError('smtpUser')}>
              <Input id="smtp-user" placeholder="user@example.com" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} aria-invalid={!!fieldError('smtpUser')} autoComplete="off" />
            </FormField>
            <FormField id="smtp-pass" label="Password *" error={fieldError('smtpPass')} hint={config.smtpPass ? 'Leave empty to keep the saved password' : undefined}>
              <Input id="smtp-pass" type="password" placeholder={config.smtpPass ? '••••••••  (saved)' : 'Enter password'} value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} aria-invalid={!!fieldError('smtpPass')} autoComplete="new-password" />
            </FormField>
          </div>
        )}

        {provider === 'resend' && (
          <FormField id="resend-key" label="Resend API Key *" error={fieldError('resendApiKey')}>
            <Input id="resend-key" type="password" placeholder={config.resendApiKey ? '••••••••  (saved)' : 're_xxxx...'} value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} aria-invalid={!!fieldError('resendApiKey')} autoComplete="off" />
            <p className="text-xs text-muted-foreground">Get your API key from <a href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">resend.com/api-keys</a></p>
          </FormField>
        )}

        {provider === 'sendgrid' && (
          <FormField id="sendgrid-key" label="SendGrid API Key *" error={fieldError('sendgridApiKey')}>
            <Input id="sendgrid-key" type="password" placeholder={config.sendgridApiKey ? '••••••••  (saved)' : 'SG.xxxx...'} value={sendgridApiKey} onChange={(e) => setSendgridApiKey(e.target.value)} aria-invalid={!!fieldError('sendgridApiKey')} autoComplete="off" />
            <p className="text-xs text-muted-foreground">Get your API key from <a href="https://app.sendgrid.com/settings/api_keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">SendGrid Settings</a></p>
          </FormField>
        )}

        {provider === 'ses' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="ses-access" label="Access Key *" error={fieldError('sesAccessKey')}>
              <Input id="ses-access" type="password" placeholder={config.sesAccessKey ? '••••••••  (saved)' : 'AKIA...'} value={sesAccessKey} onChange={(e) => setSesAccessKey(e.target.value)} aria-invalid={!!fieldError('sesAccessKey')} autoComplete="off" />
            </FormField>
            <FormField id="ses-secret" label="Secret Key *" error={fieldError('sesSecretKey')}>
              <Input id="ses-secret" type="password" placeholder={config.sesSecretKey ? '••••••••  (saved)' : 'Enter secret key'} value={sesSecretKey} onChange={(e) => setSesSecretKey(e.target.value)} aria-invalid={!!fieldError('sesSecretKey')} autoComplete="off" />
            </FormField>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ses-region">Region</Label>
              <select
                id="ses-region"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={sesRegion}
                onChange={(e) => setSesRegion(e.target.value)}
              >
                <option value="us-east-1">US East (N. Virginia)</option>
                <option value="us-east-2">US East (Ohio)</option>
                <option value="us-west-2">US West (Oregon)</option>
                <option value="eu-west-1">EU (Ireland)</option>
                <option value="eu-central-1">EU (Frankfurt)</option>
                <option value="ap-south-1">Asia Pacific (Mumbai)</option>
                <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
                <option value="ap-southeast-2">Asia Pacific (Sydney)</option>
                <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
              </select>
            </div>
          </div>
        )}

        {provider && (
          <div className="grid gap-4 sm:grid-cols-2 pt-2 border-t">
            <FormField id="sender-email" label="Sender Email *" error={fieldError('senderEmail')} hint="An address on a domain your provider is allowed to send for">
              <Input id="sender-email" placeholder="noreply@yourapp.com" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} aria-invalid={!!fieldError('senderEmail')} />
            </FormField>
            <FormField id="sender-name" label="Sender Name">
              <Input id="sender-name" placeholder="My App" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
            </FormField>
          </div>
        )}

        {!provider && (
          <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
            <Info className="h-4 w-4 shrink-0" />
            <p>
              Emails are sent using basefyio&apos;s built-in service.
              {savedProvider ? ' Save to switch back to it; the saved SMTP settings are removed.' : ' Select a provider above to use your own.'}
            </p>
          </div>
        )}

        {showErrors && providerInvalid && (
          <p className="text-xs text-destructive">Fill in the highlighted fields — an incomplete provider would stop every verification and password-reset email.</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={saving || (!provider && !savedProvider)} onClick={() => void saveProvider()}>
            {saving ? 'Saving...' : 'Save Email Settings'}
          </Button>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <Input
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="Send test to (default: your email)"
              aria-label="Test email recipient"
              className="h-9 max-w-xs"
            />
            <Button variant="outline" disabled={testing} onClick={() => void sendTest()}>
              {testing ? 'Sending…' : 'Send test email'}
            </Button>
          </div>
        </div>
        {testResult && (
          <div
            role="status"
            className={`rounded-md border p-3 text-sm ${testResult.ok
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
              : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}
          >
            {testResult.message}
            {!testResult.ok && provider && <span className="block text-xs opacity-80">Nothing was saved. The test uses the values in the form.</span>}
          </div>
        )}
      </div>

      {/* Email Templates */}
      <div className="rounded-lg border p-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Email Templates
        </h3>
        <p className="text-sm text-muted-foreground">
          Customize the emails sent to your project&apos;s users. Use variables: <code className="rounded bg-muted px-1 text-xs">{'{{otp}}'}</code> <code className="rounded bg-muted px-1 text-xs">{'{{project_name}}'}</code> <code className="rounded bg-muted px-1 text-xs">{'{{verify_url}}'}</code> <code className="rounded bg-muted px-1 text-xs">{'{{email}}'}</code>
        </p>

        <div className="space-y-3">
          {templates.map((t) => (
            <div key={t.key} className="flex items-center justify-between rounded-md border p-4">
              <div className="flex-1 min-w-0 mr-3">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{t.name}</p>
                  {config[t.subjectField] && (
                    <Badge variant="outline" className="text-xs">Customized</Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{t.description}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setEditingTemplate({ key: t.key, label: t.name })}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Customize
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* SDK Usage Example */}
      <div className="rounded-lg border p-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Info className="h-4 w-4 text-muted-foreground" />
          SDK Usage
        </h3>
        <SdkCodeBlock />
      </div>

      {editingTemplate && (() => {
        const tpl = templates.find((t) => t.key === editingTemplate.key)!;
        return (
          <TemplateEditorDialog
            projectId={projectId}
            config={config}
            templateLabel={editingTemplate.label}
            subjectField={tpl.subjectField}
            bodyField={tpl.bodyField}
            defaultSubject={tpl.defaultSubject}
            defaultBody={tpl.defaultBody}
            variables={tpl.variables}
            onClose={() => setEditingTemplate(null)}
            onSaved={onSaved}
          />
        );
      })()}
    </div>
  );
}

/* ────────────────────────────────────────────────────── Template Editor Dialog */
function TemplateEditorDialog({
  projectId,
  config,
  templateLabel,
  subjectField,
  bodyField,
  defaultSubject,
  defaultBody,
  variables,
  onClose,
  onSaved,
}: {
  projectId: string;
  config: ProjectAuthConfig;
  templateLabel: string;
  subjectField: keyof ProjectAuthConfig;
  bodyField: keyof ProjectAuthConfig;
  defaultSubject: string;
  defaultBody: string;
  variables: string[];
  onClose: () => void;
  onSaved: (c: ProjectAuthConfig) => void;
}) {
  const [subject, setSubject] = useState(
    (config[subjectField] as string | null) || defaultSubject,
  );
  const [body, setBody] = useState(
    (config[bodyField] as string | null) || defaultBody,
  );
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const previewVars: Record<string, string> = {
    '{{otp}}': '482917',
    '{{project_name}}': 'My App',
    '{{verify_url}}': 'https://api.basefyio.com/api/rest/v1/auth/verify-email-callback?otp=482917',
    '{{email}}': 'user@example.com',
    '{{invite_url}}': 'https://api.basefyio.com/api/rest/v1/auth/invite-callback?otp=482917',
    '{{magic_link_url}}': 'https://api.basefyio.com/api/rest/v1/auth/magic-link-callback?otp=482917',
    '{{confirm_url}}': 'https://api.basefyio.com/api/rest/v1/auth/change-email-callback?otp=482917',
    '{{new_email}}': 'newemail@example.com',
  };

  function applyVars(text: string) {
    return Object.entries(previewVars).reduce((s, [k, v]) => s.replaceAll(k, v), text);
  }

  /** Strip dangerous HTML for the preview: scripts, event handlers, javascript: URIs */
  function sanitizeHtmlPreview(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<script[^>]*>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '')
      .replace(/javascript\s*:/gi, 'blocked:');
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload: Record<string, string | null> = {};
      payload[subjectField as string] = subject || null;
      payload[bodyField as string] = body || null;
      const updated = await api.projects.updateAuthConfig(projectId, payload);
      onSaved(updated);
      toast.success(`${templateLabel} template saved`);
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Customize {templateLabel} Template</DialogTitle>
          <DialogDescription>
            Available variables:{' '}
            {variables.map((v, i) => (
              <span key={v}>
                <code className="rounded bg-muted px-1 text-xs">{v}</code>
                {i < variables.length - 1 && ' '}
              </span>
            ))}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Subject</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={defaultSubject}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Body (HTML)</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowPreview(!showPreview)}
                className="h-7 text-xs"
              >
                <Eye className="mr-1 h-3 w-3" />
                {showPreview ? 'Edit' : 'Preview'}
              </Button>
            </div>

            {showPreview ? (
              <div className="rounded-md border bg-white p-4 min-h-[200px]">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Subject: {applyVars(subject)}</p>
                <div className="border-t pt-2" dangerouslySetInnerHTML={{ __html: sanitizeHtmlPreview(applyVars(body)) }} />
              </div>
            ) : (
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="<h2>Your HTML template here...</h2>"
                className="min-h-[200px] font-mono text-xs"
              />
            )}
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="ghost" size="sm" onClick={() => { setSubject(defaultSubject); setBody(defaultBody); }} className="mr-auto">
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset to Default
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────── Helpers */

function ToggleSetting({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
          checked ? 'bg-primary' : 'bg-input'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

function SdkCodeBlock() {
  const [copied, setCopied] = useState(false);

  const code = `import { createClient } from 'basefyio-js'

const client = createClient({
  projectId: 'YOUR_PROJECT_ID',
  apiKey: 'YOUR_ANON_KEY',
})

// Sign up
const { data, error } = await client.auth.signUp({
  email: 'user@example.com',
  password: 'securepass',
})

// Verify email (6-digit OTP from email)
await client.auth.verifyEmail('123456')

// Sign in
await client.auth.signIn({
  email: 'user@example.com',
  password: 'securepass',
})

// Magic link (passwordless)
await client.auth.sendMagicLink('user@example.com')
await client.auth.verifyMagicLink('123456')

// Change email
await client.auth.changeEmail('new@example.com')
await client.auth.confirmChangeEmail('123456')

// Forgot password
await client.auth.forgotPassword('user@example.com')

// Reset password
await client.auth.resetPassword('123456', 'newSecurePass')

// Reauthentication (for sensitive actions)
await client.auth.requestReauth()
await client.auth.verifyReauth('123456')

// OAuth sign in (Google, GitHub)
await client.auth.signInWithProvider('google', {
  redirectTo: window.location.origin,
})

// Handle OAuth callback (on redirect page)
client.auth.handleProviderCallback()

// Invite user (requires service_role key)
await client.auth.inviteUser('newuser@example.com')

// Get current user
const { data: user } = await client.auth.getUser()`;

  function handleCopy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative">
      <button
        onClick={handleCopy}
        className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
      </button>
      <pre className="overflow-x-auto rounded-lg bg-muted/50 p-4 text-sm">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ────────────────────────────────────────────────────── Form helpers */
function FormField({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** The project's effective password rules, loaded once a dialog that needs them opens. */
function usePasswordRules(projectId: string, active: boolean): PasswordRules {
  const [rules, setRules] = useState<PasswordRules>(DEFAULT_PASSWORD_RULES);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api.projects.getAuthPolicies(projectId)
      .then((p) => { if (!cancelled) setRules(p.password); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, active]);
  return rules;
}

function PasswordChecklist({ password, rules }: { password: string; rules: PasswordRules }) {
  return (
    <ul className="space-y-0.5 text-xs" aria-label="Password requirements">
      {passwordChecks(rules).map((c) => {
        const ok = c.test(password);
        return (
          <li key={c.label} className={ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
            {ok ? '✓' : '•'} {c.label}
          </li>
        );
      })}
    </ul>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  rules,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  rules: PasswordRules;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? 'Hide password' : 'Show password'}
          aria-pressed={show}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      <PasswordChecklist password={value} rules={rules} />
    </div>
  );
}

/* ────────────────────────────────────────────────────── Edit User Dialog */
function EditUserDialog({
  open,
  user,
  projectId,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  user: RealmUser;
  projectId: string;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const initial = {
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    email: user.email || '',
    enabled: user.enabled ?? true,
    phoneNumber: user.phoneNumber || '',
    phoneVerified: user.phoneVerified ?? false,
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const phone = normalizePhone(form.phoneNumber);
  const errors: Record<string, string> = {};
  if (!form.email.trim()) errors.email = 'Email is required';
  else if (!isValidEmail(form.email)) errors.email = 'Enter a valid email address, e.g. name@example.com';
  if (phone === null) errors.phoneNumber = 'Use international format: + country code and number, e.g. +15550100100';
  if (form.phoneVerified && phone === '') errors.phoneNumber = 'Enter a number before marking it verified';
  const show = (k: string) => (submitted || (form as any)[k] !== (initial as any)[k] ? errors[k] : undefined);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    // Send only what changed, normalised the way the server stores it.
    const changes: Record<string, unknown> = {};
    if (form.firstName.trim() !== initial.firstName) changes.firstName = form.firstName.trim();
    if (form.lastName.trim() !== initial.lastName) changes.lastName = form.lastName.trim();
    if (form.email.trim() !== initial.email) changes.email = form.email.trim();
    if (form.enabled !== initial.enabled) changes.enabled = form.enabled;
    if ((phone ?? '') !== initial.phoneNumber) changes.phoneNumber = phone ?? '';
    if (form.phoneVerified !== initial.phoneVerified) changes.phoneVerified = form.phoneVerified;
    if (Object.keys(changes).length === 0) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    try {
      await api.projects.updateRealmUser(projectId, user.id, changes);
      toast.success('User updated');
      onSaved();
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
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>
            Update user details for <span className="font-medium">{user.email}</span>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <FormField id="eu-first" label="First Name">
              <Input id="eu-first" value={form.firstName} onChange={(e) => setForm((p) => ({ ...p, firstName: e.target.value }))} />
            </FormField>
            <FormField id="eu-last" label="Last Name">
              <Input id="eu-last" value={form.lastName} onChange={(e) => setForm((p) => ({ ...p, lastName: e.target.value }))} />
            </FormField>
          </div>
          <FormField id="eu-email" label="Email *" error={show('email')}>
            <Input
              id="eu-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
              aria-invalid={!!show('email')}
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField id="eu-phone" label="Phone" error={show('phoneNumber')} hint="International format, e.g. +15550100100">
              <Input
                id="eu-phone"
                value={form.phoneNumber}
                onChange={(e) => setForm((p) => ({ ...p, phoneNumber: e.target.value }))}
                placeholder="+1 555 010 0100"
                inputMode="tel"
                aria-invalid={!!show('phoneNumber')}
              />
            </FormField>
            <label className="flex items-end justify-between gap-2 pb-6">
              <span className="text-sm">Phone verified</span>
              <input
                type="checkbox"
                checked={form.phoneVerified}
                onChange={(e) => setForm((p) => ({ ...p, phoneVerified: e.target.checked }))}
                className="h-4 w-4"
              />
            </label>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Account Status</p>
              <p className="text-xs text-muted-foreground">Enable or disable this user account</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              aria-label="Account enabled"
              onClick={() => setForm((p) => ({ ...p, enabled: !p.enabled }))}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                form.enabled ? 'bg-primary' : 'bg-input'
              }`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${form.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────── Reset Password Dialog */
function ResetPasswordDialog({
  open,
  user,
  projectId,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  user: RealmUser;
  projectId: string;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const rules = usePasswordRules(projectId, open);
  const meetsPolicy = passwordChecks(rules).every((c) => c.test(password));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!meetsPolicy) return;
    setSaving(true);
    try {
      await api.projects.resetRealmUserPassword(projectId, user.id, password);
      toast.success('Password reset successfully');
      setPassword('');
      onDone();
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
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>
            Set a new password for <span className="font-medium">{user.email}</span>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <PasswordField id="rp-pass" label="New Password *" value={password} onChange={setPassword} rules={rules} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !meetsPolicy}>{saving ? 'Resetting...' : 'Reset Password'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────── Create User Dialog */
function CreateUserDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  onCreated: () => void | Promise<void>;
}) {
  const empty = { email: '', password: '', firstName: '', lastName: '' };
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const rules = usePasswordRules(projectId, open);

  function update(field: keyof typeof empty, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  const emailError = !form.email.trim()
    ? 'Email is required'
    : !isValidEmail(form.email)
      ? 'Enter a valid email address, e.g. name@example.com'
      : undefined;
  const meetsPolicy = passwordChecks(rules).every((c) => c.test(form.password));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (emailError || !meetsPolicy) return;
    setSaving(true);
    try {
      await api.projects.createRealmUser(projectId, {
        email: form.email.trim(),
        password: form.password,
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
      });
      toast.success('User created');
      setForm(empty);
      setSubmitted(false);
      onOpenChange(false);
      await onCreated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setForm(empty); setSubmitted(false); } onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create User</DialogTitle>
          <DialogDescription>
            Add a new user to this project&apos;s auth realm.
            The user will have emailVerified: true (admin-created).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <FormField id="cu-first" label="First Name">
              <Input id="cu-first" value={form.firstName} onChange={(e) => update('firstName', e.target.value)} placeholder="Optional" />
            </FormField>
            <FormField id="cu-last" label="Last Name">
              <Input id="cu-last" value={form.lastName} onChange={(e) => update('lastName', e.target.value)} placeholder="Optional" />
            </FormField>
          </div>
          <FormField id="cu-email" label="Email *" error={submitted || form.email ? emailError : undefined}>
            <Input
              id="cu-email"
              type="email"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              aria-invalid={!!(submitted && emailError)}
              autoComplete="off"
            />
          </FormField>
          <PasswordField id="cu-pass" label="Password *" value={form.password} onChange={(v) => update('password', v)} rules={rules} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !!emailError || !meetsPolicy}>{saving ? 'Creating...' : 'Create User'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
