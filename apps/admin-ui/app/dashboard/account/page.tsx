'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { parseJwt, getAccessToken } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, KeyRound, Mail, Shield } from 'lucide-react';

export default function AccountPage() {
  const router = useRouter();
  const token = getAccessToken();
  const user = token ? parseJwt(token) : null;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }

    if (newPassword.length < 6) {
      toast.error('New password must be at least 6 characters');
      return;
    }

    setSaving(true);
    try {
      await api.auth.changePassword(currentPassword, newPassword);
      toast.success('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to change password');
    } finally {
      setSaving(false);
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

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Account Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account and security settings
        </p>
      </div>

      {/* Profile info */}
      <div className="rounded-lg border p-6 space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Profile
        </h2>
        <div className="grid gap-3">
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-4 py-3">
            <div>
              <p className="text-xs text-muted-foreground">Email</p>
              <p className="text-sm font-medium">{user?.email || '—'}</p>
            </div>
            <Badge variant="secondary">Verified</Badge>
          </div>
        </div>
      </div>

      {/* Change password */}
      <div className="rounded-lg border p-6 space-y-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          Change Password
        </h2>
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current">Current Password</Label>
            <PasswordInput
              id="current"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new">New Password</Label>
            <PasswordInput
              id="new"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min 6 characters"
              required
              minLength={6}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm New Password</Label>
            <PasswordInput
              id="confirm"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
              required
              minLength={6}
            />
          </div>
          <Button type="submit" disabled={saving || !currentPassword || !newPassword || !confirmPassword}>
            {saving ? 'Changing...' : 'Change Password'}
          </Button>
        </form>
      </div>

      {/* Security info */}
      <div className="rounded-lg border border-muted bg-muted/20 p-6 space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Shield className="h-4 w-4" />
          Security
        </h2>
        <p className="text-sm text-muted-foreground">
          Your account is secured with Keycloak authentication.
          You will receive an email notification every time someone signs in to your account.
        </p>
      </div>
    </div>
  );
}
