'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';

const RULES = [
  'At least 8 characters',
  'At least one uppercase letter',
  'At least one lowercase letter',
  'At least one number',
  'At least one punctuation character',
] as const;

function isPasswordPolicyValid(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[!-/:-@[-`{-~]/.test(password)
  );
}

export default function SetNewPasswordPage() {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login');
      return;
    }

    api.auth
      .getProfile()
      .then((profile) => {
        if (!profile.forcePasswordChange) {
          Cookies.remove('basefyio_force_password_change', { path: '/' });
          router.replace('/dashboard');
          return;
        }
      })
      .catch(() => {
        router.replace('/login');
      })
      .finally(() => setChecking(false));
  }, [router]);

  const policyValid = useMemo(() => isPasswordPolicyValid(newPassword), [newPassword]);
  const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword;
  const canSubmit = policyValid && passwordsMatch && !saving;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;

    setSaving(true);
    try {
      await api.auth.completeForcedPasswordChange(newPassword);
      Cookies.remove('basefyio_force_password_change', { path: '/' });
      toast.success('Password updated. Redirecting to dashboard...');
      router.replace('/dashboard');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update password');
    } finally {
      setSaving(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <section className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Set New Password</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              For security, you must set a new password before accessing your dashboard.
            </p>
          </div>
        </div>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <PasswordInput
              id="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter your new password"
              required
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <PasswordInput
              id="confirm-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your new password"
              required
            />
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="mb-2 text-xs font-medium text-foreground">Password rules</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {RULES.map((rule) => (
                <li key={rule}>- {rule}</li>
              ))}
            </ul>
          </div>

          {confirmPassword.length > 0 && !passwordsMatch && (
            <p className="text-xs text-destructive">Passwords do not match.</p>
          )}

          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {saving ? 'Saving...' : 'Save new password'}
          </Button>
        </form>
      </section>
    </main>
  );
}
