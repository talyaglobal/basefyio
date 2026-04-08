'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Github, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useDashboard } from '@/app/dashboard/layout';
import { api } from '@/lib/api';
import type {
  AuditLogEntry,
  ManagementPlan,
  ManagementTeam,
  ManagementUser,
  ManagementUserPackage,
  ProjectDeletionReasonEntry,
  RolePermissionMatrix,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { RootAlertsPanel } from '@/components/root-alerts-panel';

const ROLE_OPTIONS = ['USER', 'ADMIN', 'ROOT'] as const;
const BYTE_UNITS = ['MB', 'GB'] as const;
type ByteUnit = (typeof BYTE_UNITS)[number];

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

type PlanDraft = {
  id: string;
  name: string;
  displayName: string;
  priceMonthlyDollars: string;
  maxProjects: string;
  maxStorageValue: string;
  maxStorageUnit: ByteUnit;
  maxDbValue: string;
  maxDbUnit: ByteUnit;
  maxTeamMembers: string;
  maxApiRequests: string;
  maxBandwidthValue: string;
  maxBandwidthUnit: ByteUnit;
  isPublic: boolean;
};

function toBigIntString(value: string, unit: ByteUnit): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const multiplier = unit === 'GB' ? 1024 ** 3 : 1024 ** 2;
  return String(Math.round(n * multiplier));
}

function fromBytes(value: string | number | null): { amount: string; unit: ByteUnit } {
  if (value === null || value === undefined || value === '') return { amount: '', unit: 'GB' };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { amount: '', unit: 'GB' };
  const gb = 1024 ** 3;
  const mb = 1024 ** 2;
  if (n >= gb) return { amount: String(Math.round((n / gb) * 100) / 100), unit: 'GB' };
  return { amount: String(Math.round((n / mb) * 100) / 100), unit: 'MB' };
}

function planToDraft(p: ManagementPlan): PlanDraft {
  const storage = fromBytes(p.maxStorageBytes);
  const db = fromBytes(p.maxDbSizeBytes);
  const bandwidth = fromBytes(p.maxBandwidthBytes);
  return {
    id: p.id,
    name: p.name,
    displayName: p.displayName,
    priceMonthlyDollars: String((p.priceMonthly || 0) / 100),
    maxProjects: p.maxProjects === null ? '' : String(p.maxProjects),
    maxStorageValue: storage.amount,
    maxStorageUnit: storage.unit,
    maxDbValue: db.amount,
    maxDbUnit: db.unit,
    maxTeamMembers: p.maxTeamMembers === null ? '' : String(p.maxTeamMembers),
    maxApiRequests: p.maxApiRequests === null ? '' : String(p.maxApiRequests),
    maxBandwidthValue: bandwidth.amount,
    maxBandwidthUnit: bandwidth.unit,
    isPublic: p.isPublic,
  };
}

export default function ManagementPage() {
  const router = useRouter();
  const { profile } = useDashboard();
  const [users, setUsers] = useState<ManagementUser[]>([]);
  const [teams, setTeams] = useState<ManagementTeam[]>([]);
  const [plans, setPlans] = useState<ManagementPlan[]>([]);
  const [userPackages, setUserPackages] = useState<ManagementUserPackage[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [projectDeletionReasons, setProjectDeletionReasons] = useState<ProjectDeletionReasonEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingRoleUserId, setSavingRoleUserId] = useState<string | null>(null);
  const [savingActiveUserId, setSavingActiveUserId] = useState<string | null>(null);
  const [deletingTeamId, setDeletingTeamId] = useState<string | null>(null);
  const [savingPackageUserId, setSavingPackageUserId] = useState<string | null>(null);
  const [savingPlanName, setSavingPlanName] = useState<string | null>(null);
  const [rolePermissions, setRolePermissions] = useState<RolePermissionMatrix[]>([]);
  const [savingRoleMatrixRole, setSavingRoleMatrixRole] = useState<
    'USER' | 'ADMIN' | 'ROOT' | null
  >(null);
  const [planDrafts, setPlanDrafts] = useState<Record<string, PlanDraft>>({});
  const [savingAllPlans, setSavingAllPlans] = useState(false);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [newPlan, setNewPlan] = useState({
    name: '',
    displayName: '',
    priceMonthlyDollars: '0',
  });
  const [passwordDialogUser, setPasswordDialogUser] = useState<ManagementUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [forceChangeOnFirstLogin, setForceChangeOnFirstLogin] = useState(true);
  const [savingPassword, setSavingPassword] = useState(false);
  const [auditSearch, setAuditSearch] = useState('');
  const [auditPage, setAuditPage] = useState(1);
  const [auditActionPreview, setAuditActionPreview] = useState<{
    id: string;
    action: string;
  } | null>(null);
  const [managementPermissions, setManagementPermissions] = useState<RolePermissionMatrix | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<
    'users' | 'plans' | 'teams' | 'audit' | 'permissions'
  >('users');

  const isRoot = profile?.role === 'ROOT';
  const canAccessManagement = isRoot || !!managementPermissions?.canAccessManagement;
  const AUDIT_PAGE_SIZE = 20;

  const filteredAuditLogs = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return auditLogs;
    return auditLogs.filter((log) => {
      return (
        log.action.toLowerCase().includes(q) ||
        log.actorUserId.toLowerCase().includes(q) ||
        log.resourceType.toLowerCase().includes(q) ||
        (log.resourceId || '').toLowerCase().includes(q) ||
        log.traceId.toLowerCase().includes(q)
      );
    });
  }, [auditLogs, auditSearch]);

  const auditTotalPages = Math.max(1, Math.ceil(filteredAuditLogs.length / AUDIT_PAGE_SIZE));
  const pagedAuditLogs = useMemo(() => {
    const start = (auditPage - 1) * AUDIT_PAGE_SIZE;
    return filteredAuditLogs.slice(start, start + AUDIT_PAGE_SIZE);
  }, [filteredAuditLogs, auditPage]);

  async function load() {
    setLoading(true);
    try {
      const myPermissions = await api.auth.managementMyPermissions();
      setManagementPermissions(myPermissions);

      const [usersData, teamsData, plansData, packagesData, rolePermissionData, auditData] =
        await Promise.all([
          myPermissions.canManageUsers ? api.auth.managementUsers() : Promise.resolve([]),
          myPermissions.canManageTeams ? api.auth.managementTeams() : Promise.resolve([]),
          myPermissions.canManagePlans ? api.billing.managementPlans() : Promise.resolve([]),
          myPermissions.canManageUserPackages
            ? api.billing.managementUserPackages()
            : Promise.resolve([]),
          myPermissions.role === 'ROOT'
            ? api.auth.managementRolePermissions()
            : Promise.resolve([]),
          myPermissions.canViewAuditLogs
            ? api.observability.listAuditLogs(200)
            : Promise.resolve([]),
        ]);
      setUsers(usersData);
      setTeams(teamsData);
      setPlans(plansData);
      setPlanDrafts(
        plansData.reduce<Record<string, PlanDraft>>((acc, p) => {
          acc[p.id] = planToDraft(p);
          return acc;
        }, {}),
      );
      setUserPackages(packagesData);
      setRolePermissions(rolePermissionData);
      setAuditLogs(auditData);
      if (myPermissions.role === 'ROOT') {
        const deletionReasons = await api.projects.listDeletionReasons(200);
        setProjectDeletionReasons(deletionReasons);
      } else {
        setProjectDeletionReasons([]);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to load management data');
    } finally {
      setLoading(false);
    }
  }

  function generatePassword() {
    const chars =
      'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+';
    let out = '';
    for (let i = 0; i < 16; i += 1) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    setNewPassword(out);
  }

  async function handleResetPassword() {
    if (!passwordDialogUser) return;
    if (!newPassword.trim()) {
      toast.error('Please enter a password');
      return;
    }
    setSavingPassword(true);
    try {
      await api.auth.resetManagementUserPassword(passwordDialogUser.id, {
        newPassword: newPassword.trim(),
        forceChangeOnFirstLogin,
      });
      toast.success(`Password reset for ${passwordDialogUser.email}`);
      setPasswordDialogUser(null);
      setNewPassword('');
      setForceChangeOnFirstLogin(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to reset password');
    } finally {
      setSavingPassword(false);
    }
  }

  useEffect(() => {
    if (profile === null) return;
    load();
  }, [profile, router]);

  useEffect(() => {
    setAuditPage(1);
  }, [auditSearch]);

  useEffect(() => {
    if (auditPage > auditTotalPages) {
      setAuditPage(auditTotalPages);
    }
  }, [auditPage, auditTotalPages]);

  async function handleSavePlanChanges() {
    setSavingAllPlans(true);
    try {
      const originalById = plans.reduce<Record<string, ManagementPlan>>((acc, p) => {
        acc[p.id] = p;
        return acc;
      }, {});
      for (const draft of Object.values(planDrafts)) {
        const original = originalById[draft.id];
        if (!original) continue;
        const payload = {
          displayName: draft.displayName.trim(),
          priceMonthly: Math.round((Number(draft.priceMonthlyDollars || '0') || 0) * 100),
          maxProjects: draft.maxProjects.trim() === '' ? null : Number(draft.maxProjects),
          maxStorageBytes:
            draft.maxStorageValue.trim() === ''
              ? null
              : toBigIntString(draft.maxStorageValue, draft.maxStorageUnit),
          maxDbSizeBytes:
            draft.maxDbValue.trim() === ''
              ? null
              : toBigIntString(draft.maxDbValue, draft.maxDbUnit),
          maxTeamMembers:
            draft.maxTeamMembers.trim() === '' ? null : Number(draft.maxTeamMembers),
          maxApiRequests:
            draft.maxApiRequests.trim() === '' ? null : Number(draft.maxApiRequests),
          maxBandwidthBytes:
            draft.maxBandwidthValue.trim() === ''
              ? null
              : toBigIntString(draft.maxBandwidthValue, draft.maxBandwidthUnit),
          isPublic: draft.isPublic,
        };
        await api.billing.updateManagementPlan(original.name, payload);
      }
      toast.success('Plan changes saved');
      await load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save plan changes');
    } finally {
      setSavingAllPlans(false);
    }
  }

  async function handleCreatePlan() {
    if (!newPlan.name.trim() || !newPlan.displayName.trim()) {
      toast.error('Plan name and display name are required');
      return;
    }
    setCreatingPlan(true);
    try {
      await api.billing.createManagementPlan({
        name: newPlan.name.trim().toLowerCase(),
        displayName: newPlan.displayName.trim(),
        priceMonthly: Math.round((Number(newPlan.priceMonthlyDollars || '0') || 0) * 100),
        isPublic: true,
      });
      toast.success('New plan created');
      setNewPlan({ name: '', displayName: '', priceMonthlyDollars: '0' });
      await load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create plan');
    } finally {
      setCreatingPlan(false);
    }
  }

  if (profile === null || loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canAccessManagement) {
    return null;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Management
          </h1>
          <p className="text-sm text-muted-foreground">
            Role-based management area. Permissions are controlled by ROOT.
          </p>
        </div>
        <Button variant="outline" onClick={load}>
          Refresh
        </Button>
      </div>

      <div className="inline-flex rounded-lg border bg-muted p-1">
        {isRoot && (
        <button
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            activeTab === 'permissions'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('permissions')}
        >
          Permissions
        </button>
        )}
        {(managementPermissions?.canManageUsers || isRoot) && (
        <button
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            activeTab === 'users'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('users')}
        >
          Users
        </button>
        )}
        {(managementPermissions?.canManagePlans || isRoot) && (
        <button
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            activeTab === 'plans'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('plans')}
        >
          Pricing Plans
        </button>
        )}
        {(managementPermissions?.canManageTeams || isRoot) && (
        <button
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            activeTab === 'teams'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('teams')}
        >
          Teams
        </button>
        )}
        {(managementPermissions?.canViewAuditLogs || isRoot) && (
        <button
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            activeTab === 'audit'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('audit')}
        >
          Audit Logs
        </button>
        )}
      </div>

      <RootAlertsPanel />

      {activeTab === 'permissions' && isRoot && (
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div>
          <h2 className="text-base font-semibold">Role Permission Matrix</h2>
          <p className="text-sm text-muted-foreground">
            Root user can configure what USER and ADMIN can do. ROOT permissions stay fixed.
          </p>
        </div>
        {isRoot && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Project Deletion Reasons</h3>
              <p className="text-xs text-muted-foreground">
                Last {projectDeletionReasons.length} records
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="px-2 py-2">Time</th>
                    <th className="px-2 py-2">Project</th>
                    <th className="px-2 py-2">Reason</th>
                    <th className="px-2 py-2">Details</th>
                    <th className="px-2 py-2">Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {projectDeletionReasons.length === 0 ? (
                    <tr>
                      <td className="px-2 py-5 text-center text-muted-foreground" colSpan={5}>
                        No project deletion reason records yet.
                      </td>
                    </tr>
                  ) : (
                    projectDeletionReasons.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="px-2 py-2 text-muted-foreground">
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                        <td className="px-2 py-2 font-medium">
                          {row.projectName || row.projectId}
                        </td>
                        <td className="px-2 py-2">{row.reasonLabel || 'None of the above'}</td>
                        <td
                          className="max-w-[360px] truncate px-2 py-2 text-muted-foreground"
                          title={row.details || ''}
                        >
                          {row.details || '-'}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {row.actorUserId || '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1160px] text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2">Management Access</th>
                <th className="px-2 py-2">Manage Users</th>
                <th className="px-2 py-2">Manage Teams</th>
                <th className="px-2 py-2">Manage Plans</th>
                <th className="px-2 py-2">Manage User Packages</th>
                <th className="px-2 py-2">Moderate Feedback</th>
                <th className="px-2 py-2">View Audit Logs</th>
                <th className="px-2 py-2">View Root Alerts</th>
              </tr>
            </thead>
            <tbody>
              {rolePermissions.map((row) => {
                const isRootRow = row.role === 'ROOT';
                const isSaving = savingRoleMatrixRole === row.role;
                const togglePermission = async (
                  key: keyof Omit<RolePermissionMatrix, 'role'>,
                  nextValue: boolean,
                ) => {
                  if (isRootRow) return;
                  setSavingRoleMatrixRole(row.role);
                  try {
                    const updated = await api.auth.updateManagementRolePermissions(row.role, {
                      [key]: nextValue,
                    });
                    setRolePermissions((prev) =>
                      prev.map((x) => (x.role === row.role ? updated : x)),
                    );
                    toast.success(`${row.role} permissions updated`);
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to update role permissions');
                  } finally {
                    setSavingRoleMatrixRole(null);
                  }
                };

                return (
                  <tr key={row.role} className="border-b last:border-0">
                    <td className="px-2 py-2 font-semibold">{row.role}</td>
                    {(
                      [
                        'canAccessManagement',
                        'canManageUsers',
                        'canManageTeams',
                        'canManagePlans',
                        'canManageUserPackages',
                        'canModerateFeedback',
                        'canViewAuditLogs',
                        'canViewRootAlerts',
                      ] as const
                    ).map((permissionKey) => (
                      <td key={permissionKey} className="px-2 py-2">
                        <input
                          type="checkbox"
                          checked={row[permissionKey]}
                          disabled={isRootRow || isSaving}
                          onChange={(e) => {
                            void togglePermission(permissionKey, e.target.checked);
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {activeTab === 'users' && (managementPermissions?.canManageUsers || isRoot) && (
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">Users</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Email</th>
                <th className="px-2 py-2">Sign In</th>
                <th className="px-2 py-2">Teams</th>
                <th className="px-2 py-2">Package</th>
                <th className="px-2 py-2">Created</th>
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Password</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="px-2 py-2 font-medium">
                    {u.firstName || u.lastName
                      ? `${u.firstName || ''} ${u.lastName || ''}`.trim()
                      : u.username}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{u.email}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      {u.signOnMethod === 'google' ? (
                        <GoogleIcon className="h-4 w-4" />
                      ) : u.signOnMethod === 'github' ? (
                        <Github className="h-4 w-4" />
                      ) : (
                        <KeyRound className="h-4 w-4 text-emerald-700" />
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2">{u._count.teamMembers}</td>
                  <td className="px-2 py-2">
                    {(() => {
                      const p = userPackages.find((x) => x.userId === u.id);
                      if (!p) return 'N/A';
                      return (
                        <select
                          value={p.planName || ''}
                          disabled={savingPackageUserId === u.id || !p.teamId}
                          onChange={async (e) => {
                            const nextPlanName = e.target.value;
                            if (!nextPlanName) return;
                            setSavingPackageUserId(u.id);
                            try {
                              const updated = await api.billing.updateManagementUserPackage(u.id, nextPlanName);
                              setUserPackages((prev) =>
                                prev.map((x) =>
                                  x.userId === u.id
                                    ? {
                                        ...x,
                                        planName: updated.planName,
                                        planDisplayName: updated.planDisplayName,
                                        planPriceMonthly: updated.planPriceMonthly,
                                      }
                                    : x,
                                ),
                              );
                              toast.success(`${u.username} package updated`);
                            } catch (err: any) {
                              toast.error(err.message || 'Failed to update package');
                            } finally {
                              setSavingPackageUserId(null);
                            }
                          }}
                          className="rounded-md border bg-background px-2 py-1 text-xs font-medium"
                        >
                          <option value="" disabled>
                            Select package
                          </option>
                          {plans.map((plan) => (
                            <option key={plan.id} value={plan.name}>
                              {plan.displayName}
                            </option>
                          ))}
                        </select>
                      );
                    })()}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={u.role}
                      disabled={savingRoleUserId === u.id}
                      onChange={async (e) => {
                        const nextRole = e.target.value as (typeof ROLE_OPTIONS)[number];
                        setSavingRoleUserId(u.id);
                        try {
                          const updated = await api.auth.updateManagementUserRole(u.id, nextRole);
                          setUsers((prev) =>
                            prev.map((x) => (x.id === u.id ? { ...x, role: updated.role } : x)),
                          );
                          toast.success(`Role updated to ${updated.role}`);
                        } catch (err: any) {
                          toast.error(err.message || 'Failed to update role');
                        } finally {
                          setSavingRoleUserId(null);
                        }
                      }}
                      className="rounded-md border bg-background px-2 py-1 text-xs font-medium"
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          u.isActive === false
                            ? 'bg-red-100 text-red-700'
                            : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {u.isActive === false ? 'Inactive' : 'Active'}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingActiveUserId === u.id}
                        onClick={async () => {
                          const next = !(u.isActive !== false);
                          setSavingActiveUserId(u.id);
                          try {
                            const updated = await api.auth.updateManagementUserActive(u.id, next);
                            setUsers((prev) =>
                              prev.map((x) =>
                                x.id === u.id ? { ...x, isActive: updated.isActive } : x,
                              ),
                            );
                            toast.success(
                              updated.isActive
                                ? `${u.username} activated`
                                : `${u.username} deactivated`,
                            );
                          } catch (err: any) {
                            toast.error(err.message || 'Failed to update user status');
                          } finally {
                            setSavingActiveUserId(null);
                          }
                        }}
                      >
                        {u.isActive === false ? 'Activate' : 'Deactivate'}
                      </Button>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    {u.signOnMethod !== 'local' ? (
                      <span
                        className="inline-block cursor-not-allowed rounded-md border border-muted px-3 py-1.5 text-xs text-muted-foreground"
                        title={`Password reset is disabled because this user signed up with ${u.signOnMethod}.`}
                      >
                        Reset Password
                      </span>
                    ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setPasswordDialogUser(u);
                        setNewPassword('');
                        setForceChangeOnFirstLogin(true);
                      }}
                    >
                      Reset Password
                    </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {activeTab === 'plans' && (managementPermissions?.canManagePlans || isRoot) && (
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Pricing Plans</h2>
          <Button onClick={handleSavePlanChanges} disabled={savingAllPlans || !!savingPlanName}>
            {savingAllPlans ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
        <div className="grid gap-2 rounded-lg border p-3 md:grid-cols-4">
          <Input
            placeholder="plan-name (e.g. enterprise)"
            value={newPlan.name}
            onChange={(e) => setNewPlan((p) => ({ ...p, name: e.target.value }))}
          />
          <Input
            placeholder="Display name"
            value={newPlan.displayName}
            onChange={(e) => setNewPlan((p) => ({ ...p, displayName: e.target.value }))}
          />
          <Input
            type="number"
            placeholder="Monthly USD"
            value={newPlan.priceMonthlyDollars}
            onChange={(e) => setNewPlan((p) => ({ ...p, priceMonthlyDollars: e.target.value }))}
          />
          <Button onClick={handleCreatePlan} disabled={creatingPlan}>
            {creatingPlan ? 'Creating...' : 'Add New Plan'}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2">Plan Name</th>
                <th className="px-2 py-2">Price Monthly (USD)</th>
                <th className="px-2 py-2">Projects</th>
                <th className="px-2 py-2">Storage (MB/GB)</th>
                <th className="px-2 py-2">DB Size (MB/GB)</th>
                <th className="px-2 py-2">Team Members</th>
                <th className="px-2 py-2">API Req / Mo</th>
                <th className="px-2 py-2">Bandwidth (MB/GB)</th>
                <th className="px-2 py-2">Public</th>
                <th className="px-2 py-2">Delete</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  {(() => {
                    const d = planDrafts[p.id] ?? planToDraft(p);
                    return (
                      <>
                  <td className="px-2 py-2">
                    <Input
                      value={d.displayName}
                      className="h-8 w-40"
                      onChange={(e) =>
                        setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, displayName: e.target.value } }))
                      }
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      value={d.priceMonthlyDollars}
                      className="h-8 w-24"
                      onChange={(e) =>
                        setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, priceMonthlyDollars: e.target.value } }))
                      }
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      value={d.maxProjects}
                      placeholder="Unlimited"
                      className="h-8 w-24"
                      onChange={(e) =>
                        setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxProjects: e.target.value } }))
                      }
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        value={d.maxStorageValue}
                        placeholder="Unlimited"
                        className="h-8 w-24"
                        onChange={(e) =>
                          setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxStorageValue: e.target.value } }))
                        }
                      />
                      <select
                        value={d.maxStorageUnit}
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                        onChange={(e) =>
                          setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxStorageUnit: e.target.value as ByteUnit } }))
                        }
                      >
                        {BYTE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        value={d.maxDbValue}
                        placeholder="Unlimited"
                        className="h-8 w-24"
                        onChange={(e) =>
                          setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxDbValue: e.target.value } }))
                        }
                      />
                      <select
                        value={d.maxDbUnit}
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                        onChange={(e) =>
                          setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxDbUnit: e.target.value as ByteUnit } }))
                        }
                      >
                        {BYTE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      value={d.maxTeamMembers}
                      placeholder="Unlimited"
                      className="h-8 w-24"
                      onChange={(e) =>
                        setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxTeamMembers: e.target.value } }))
                      }
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      value={d.maxApiRequests}
                      placeholder="Unlimited"
                      className="h-8 w-28"
                      onChange={(e) =>
                        setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxApiRequests: e.target.value } }))
                      }
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        value={d.maxBandwidthValue}
                        placeholder="Unlimited"
                        className="h-8 w-24"
                        onChange={(e) =>
                          setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxBandwidthValue: e.target.value } }))
                        }
                      />
                      <select
                        value={d.maxBandwidthUnit}
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                        onChange={(e) =>
                          setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, maxBandwidthUnit: e.target.value as ByteUnit } }))
                        }
                      >
                        {BYTE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <label className="inline-flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={d.isPublic}
                        onChange={(e) =>
                          setPlanDrafts((prev) => ({ ...prev, [p.id]: { ...d, isPublic: e.target.checked } }))
                        }
                        disabled={savingPlanName === p.name}
                      />
                      {d.isPublic ? 'Yes' : 'No'}
                    </label>
                  </td>
                  <td className="px-2 py-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 hover:text-red-700"
                      disabled={p.name === 'free'}
                      onClick={async () => {
                        if (p.name === 'free') return;
                        const ok = window.confirm(
                          `Delete "${p.displayName}" plan? Existing subscriptions will be moved to Free.`,
                        );
                        if (!ok) return;
                        try {
                          const res = await api.billing.deleteManagementPlan(p.name, 'free');
                          toast.success(
                            `${res.deletedPlan} deleted, ${res.migratedSubscriptions} subscription(s) moved to ${res.replacementPlan}.`,
                          );
                          await load();
                        } catch (err: any) {
                          toast.error(err.message || 'Failed to delete plan');
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                      </>
                    );
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {activeTab === 'teams' && (managementPermissions?.canManageTeams || isRoot) && (
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">Teams</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2">Team</th>
                <th className="px-2 py-2">Slug</th>
                <th className="px-2 py-2">Owner</th>
                <th className="px-2 py-2">Members</th>
                <th className="px-2 py-2">Projects</th>
                <th className="px-2 py-2">Created</th>
                <th className="px-2 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="px-2 py-2 font-medium">{t.name}</td>
                  <td className="px-2 py-2 text-muted-foreground">{t.slug}</td>
                  <td className="px-2 py-2">
                    {t.owner ? `${t.owner.username} (${t.owner.email})` : 'N/A'}
                  </td>
                  <td className="px-2 py-2">{t.memberCount}</td>
                  <td className="px-2 py-2">{t.projectCount}</td>
                  <td className="px-2 py-2 text-muted-foreground">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-2 py-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 hover:text-red-700"
                      disabled={deletingTeamId === t.id || t.projectCount > 0}
                      title={
                        t.projectCount > 0
                          ? 'Delete projects first to remove this team'
                          : undefined
                      }
                      onClick={async () => {
                        const ok = window.confirm(
                          `Delete "${t.name}" team? This action cannot be undone.`,
                        );
                        if (!ok) return;
                        setDeletingTeamId(t.id);
                        try {
                          await api.auth.deleteManagementTeam(t.id);
                          setTeams((prev) => prev.filter((x) => x.id !== t.id));
                          toast.success(`Team "${t.name}" deleted`);
                        } catch (err: any) {
                          toast.error(err.message || 'Failed to delete team');
                        } finally {
                          setDeletingTeamId(null);
                        }
                      }}
                    >
                      {deletingTeamId === t.id ? 'Deleting...' : 'Delete'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {activeTab === 'audit' && (managementPermissions?.canViewAuditLogs || isRoot) && (
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Audit Logs</h2>
          <p className="text-xs text-muted-foreground">
            Showing {pagedAuditLogs.length} / {filteredAuditLogs.length} records
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Input
            value={auditSearch}
            onChange={(e) => setAuditSearch(e.target.value)}
            placeholder="Search action, actor, resource, trace id..."
            className="h-9 w-full max-w-sm"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={auditPage <= 1}
              onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {auditPage} / {auditTotalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={auditPage >= auditTotalPages}
              onClick={() => setAuditPage((p) => Math.min(auditTotalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1220px] text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2">Severity</th>
                <th className="px-2 py-2">Result</th>
                <th className="px-2 py-2">Action</th>
                <th className="px-2 py-2">Actor</th>
                <th className="px-2 py-2">Resource</th>
                <th className="px-2 py-2">Trace ID</th>
              </tr>
            </thead>
            <tbody>
              {filteredAuditLogs.length === 0 ? (
                <tr>
                  <td className="px-2 py-6 text-center text-muted-foreground" colSpan={7}>
                    No matching audit records.
                  </td>
                </tr>
              ) : (
                pagedAuditLogs.map((log) => (
                  <tr key={log.id} className="border-b last:border-0">
                    <td className="px-2 py-2 text-muted-foreground">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          log.severity === 'CRITICAL'
                            ? 'bg-red-100 text-red-700'
                            : log.severity === 'HIGH'
                              ? 'bg-orange-100 text-orange-700'
                              : log.severity === 'MEDIUM'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {log.severity}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          log.success ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {log.success ? 'SUCCESS' : 'FAILED'}
                      </span>
                    </td>
                    <td className="max-w-[280px] px-2 py-2">
                      <button
                        type="button"
                        className="w-full truncate text-left font-medium hover:underline"
                        title="Click to view full action"
                        onClick={() => setAuditActionPreview({ id: log.id, action: log.action })}
                      >
                        {log.action}
                      </button>
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">{log.actorUserId}</td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {log.resourceType}
                      {log.resourceId ? `:${log.resourceId}` : ''}
                    </td>
                    <td className="max-w-[260px] truncate px-2 py-2 font-mono text-xs text-muted-foreground" title={log.traceId}>
                      {log.traceId}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      )}

      <Dialog
        open={!!auditActionPreview}
        onOpenChange={(open) => {
          if (!open) setAuditActionPreview(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogTitle>Audit Action</DialogTitle>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Log ID: {auditActionPreview?.id}</p>
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="break-all text-sm font-medium">{auditActionPreview?.action}</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!passwordDialogUser}
        onOpenChange={(open) => {
          if (!open) {
            setPasswordDialogUser(null);
            setNewPassword('');
            setForceChangeOnFirstLogin(true);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>Reset User Password</DialogTitle>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {passwordDialogUser?.email}
            </p>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  className="pr-10"
                />
                <button
                  type="button"
                  aria-label="Copy password"
                  title="Copy password"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={async () => {
                    if (!newPassword) {
                      toast.error('No password to copy');
                      return;
                    }
                    try {
                      await navigator.clipboard.writeText(newPassword);
                      toast.success('Password copied');
                    } catch {
                      toast.error('Could not copy password');
                    }
                  }}
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              <Button type="button" variant="outline" onClick={generatePassword}>
                Generate Password
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={forceChangeOnFirstLogin}
                onChange={(e) => setForceChangeOnFirstLogin(e.target.checked)}
              />
              Force user to change password on next login
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setPasswordDialogUser(null);
                  setNewPassword('');
                  setForceChangeOnFirstLogin(true);
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleResetPassword} disabled={savingPassword}>
                {savingPassword ? 'Saving...' : 'Reset Password'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
