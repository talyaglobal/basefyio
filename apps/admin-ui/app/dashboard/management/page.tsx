'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useDashboard } from '@/app/dashboard/layout';
import { api } from '@/lib/api';
import type {
  ManagementPlan,
  ManagementTeam,
  ManagementUser,
  ManagementUserPackage,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

const ROLE_OPTIONS = ['USER', 'ADMIN', 'ROOT'] as const;

export default function ManagementPage() {
  const router = useRouter();
  const { profile } = useDashboard();
  const [users, setUsers] = useState<ManagementUser[]>([]);
  const [teams, setTeams] = useState<ManagementTeam[]>([]);
  const [plans, setPlans] = useState<ManagementPlan[]>([]);
  const [userPackages, setUserPackages] = useState<ManagementUserPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingRoleUserId, setSavingRoleUserId] = useState<string | null>(null);
  const [savingPackageUserId, setSavingPackageUserId] = useState<string | null>(null);
  const [savingPlanName, setSavingPlanName] = useState<string | null>(null);
  const [passwordDialogUser, setPasswordDialogUser] = useState<ManagementUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [forceChangeOnFirstLogin, setForceChangeOnFirstLogin] = useState(true);
  const [savingPassword, setSavingPassword] = useState(false);

  const isRoot = profile?.role === 'ROOT';

  async function load() {
    setLoading(true);
    try {
      const [usersData, teamsData, plansData, packagesData] = await Promise.all([
        api.auth.managementUsers(),
        api.auth.managementTeams(),
        api.billing.managementPlans(),
        api.billing.managementUserPackages(),
      ]);
      setUsers(usersData);
      setTeams(teamsData);
      setPlans(plansData);
      setUserPackages(packagesData);
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
    if (!isRoot) {
      router.replace('/dashboard');
      return;
    }
    load();
  }, [profile, isRoot, router]);

  if (profile === null || loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isRoot) {
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
            Root-only system area to manage platform users and teams.
          </p>
        </div>
        <Button variant="outline" onClick={load}>
          Refresh
        </Button>
      </div>

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">Users</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Email</th>
                <th className="px-2 py-2">Teams</th>
                <th className="px-2 py-2">Package</th>
                <th className="px-2 py-2">Created</th>
                <th className="px-2 py-2">Role</th>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">Pricing Plans</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-2 py-2">Plan Name</th>
                <th className="px-2 py-2">Price Monthly (USD)</th>
                <th className="px-2 py-2">Projects</th>
                <th className="px-2 py-2">Storage (bytes)</th>
                <th className="px-2 py-2">DB Size (bytes)</th>
                <th className="px-2 py-2">Team Members</th>
                <th className="px-2 py-2">API Req / Mo</th>
                <th className="px-2 py-2">Bandwidth (bytes)</th>
                <th className="px-2 py-2">Public</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="px-2 py-2">
                    <Input
                      defaultValue={p.displayName}
                      className="h-8 w-40"
                      onBlur={async (e) => {
                        const next = e.target.value.trim();
                        if (!next || next === p.displayName) return;
                        setSavingPlanName(p.name);
                        try {
                          const updated = await api.billing.updateManagementPlan(p.name, {
                            displayName: next,
                          });
                          setPlans((prev) =>
                            prev.map((x) =>
                              x.id === p.id ? { ...x, displayName: updated.displayName } : x,
                            ),
                          );
                          toast.success(`${p.name} name updated`);
                        } catch (err: any) {
                          toast.error(err.message || 'Failed to update plan name');
                        } finally {
                          setSavingPlanName(null);
                        }
                      }}
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      defaultValue={(p.priceMonthly / 100).toString()}
                      className="h-8 w-24"
                      onBlur={async (e) => {
                        const dollars = Number(e.target.value);
                        if (!Number.isFinite(dollars) || dollars < 0) return;
                        setSavingPlanName(p.name);
                        try {
                          const updated = await api.billing.updateManagementPlan(p.name, {
                            priceMonthly: Math.round(dollars * 100),
                          });
                          setPlans((prev) =>
                            prev.map((x) =>
                              x.id === p.id ? { ...x, priceMonthly: updated.priceMonthly } : x,
                            ),
                          );
                          toast.success(`${p.displayName} price updated`);
                        } catch (err: any) {
                          toast.error(err.message || 'Failed to update price');
                        } finally {
                          setSavingPlanName(null);
                        }
                      }}
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      defaultValue={p.maxProjects ?? ''}
                      placeholder="Unlimited"
                      className="h-8 w-24"
                      onBlur={async (e) => {
                        const raw = e.target.value.trim();
                        const next = raw === '' ? null : Number(raw);
                        if (raw !== '' && (!Number.isFinite(next) || (next as number) < 0)) return;
                        setSavingPlanName(p.name);
                        try {
                          const updated = await api.billing.updateManagementPlan(p.name, {
                            maxProjects: next as number | null,
                          });
                          setPlans((prev) => prev.map((x) => (x.id === p.id ? { ...x, maxProjects: updated.maxProjects } : x)));
                        } finally {
                          setSavingPlanName(null);
                        }
                      }}
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="text"
                      defaultValue={p.maxStorageBytes ?? ''}
                      placeholder="Unlimited"
                      className="h-8 w-36"
                      onBlur={async (e) => {
                        const raw = e.target.value.trim();
                        setSavingPlanName(p.name);
                        try {
                          const updated = await api.billing.updateManagementPlan(p.name, {
                            maxStorageBytes: raw === '' ? null : raw,
                          });
                          setPlans((prev) => prev.map((x) => (x.id === p.id ? { ...x, maxStorageBytes: updated.maxStorageBytes } : x)));
                        } finally {
                          setSavingPlanName(null);
                        }
                      }}
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="text"
                      defaultValue={p.maxDbSizeBytes ?? ''}
                      placeholder="Unlimited"
                      className="h-8 w-36"
                      onBlur={async (e) => {
                        const raw = e.target.value.trim();
                        setSavingPlanName(p.name);
                        try {
                          const updated = await api.billing.updateManagementPlan(p.name, {
                            maxDbSizeBytes: raw === '' ? null : raw,
                          });
                          setPlans((prev) => prev.map((x) => (x.id === p.id ? { ...x, maxDbSizeBytes: updated.maxDbSizeBytes } : x)));
                        } finally {
                          setSavingPlanName(null);
                        }
                      }}
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      defaultValue={p.maxTeamMembers ?? ''}
                      placeholder="Unlimited"
                      className="h-8 w-24"
                      onBlur={async (e) => {
                        const raw = e.target.value.trim();
                        const next = raw === '' ? null : Number(raw);
                        if (raw !== '' && (!Number.isFinite(next) || (next as number) < 0)) return;
                        setSavingPlanName(p.name);
                        try {
                          const updated = await api.billing.updateManagementPlan(p.name, {
                            maxTeamMembers: next as number | null,
                          });
                          setPlans((prev) => prev.map((x) => (x.id === p.id ? { ...x, maxTeamMembers: updated.maxTeamMembers } : x)));
                        } finally {
                          setSavingPlanName(null);
                        }
                      }}
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      defaultValue={p.maxApiRequests ?? ''}
                      placeholder="Unlimited"
                      className="h-8 w-28"
                      onBlur={async (e) => {
                        const raw = e.target.value.trim();
                        const next = raw === '' ? null : Number(raw);
                        if (raw !== '' && (!Number.isFinite(next) || (next as number) < 0)) return;
                        setSavingPlanName(p.name);
                        try {
                          const updated = await api.billing.updateManagementPlan(p.name, {
                            maxApiRequests: next as number | null,
                          });
                          setPlans((prev) => prev.map((x) => (x.id === p.id ? { ...x, maxApiRequests: updated.maxApiRequests } : x)));
                        } finally {
                          setSavingPlanName(null);
                        }
                      }}
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="text"
                      defaultValue={p.maxBandwidthBytes ?? ''}
                      placeholder="Unlimited"
                      className="h-8 w-36"
                      onBlur={async (e) => {
                        const raw = e.target.value.trim();
                        setSavingPlanName(p.name);
                        try {
                          const updated = await api.billing.updateManagementPlan(p.name, {
                            maxBandwidthBytes: raw === '' ? null : raw,
                          });
                          setPlans((prev) => prev.map((x) => (x.id === p.id ? { ...x, maxBandwidthBytes: updated.maxBandwidthBytes } : x)));
                        } finally {
                          setSavingPlanName(null);
                        }
                      }}
                      disabled={savingPlanName === p.name}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <label className="inline-flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={p.isPublic}
                        onChange={async (e) => {
                          const next = e.target.checked;
                          setSavingPlanName(p.name);
                          try {
                            const updated = await api.billing.updateManagementPlan(p.name, {
                              isPublic: next,
                            });
                            setPlans((prev) =>
                              prev.map((x) => (x.id === p.id ? { ...x, isPublic: updated.isPublic } : x)),
                            );
                          } finally {
                            setSavingPlanName(null);
                          }
                        }}
                        disabled={savingPlanName === p.name}
                      />
                      {p.isPublic ? 'Yes' : 'No'}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
