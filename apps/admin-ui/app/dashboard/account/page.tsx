'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { parseJwt, getAccessToken } from '@/lib/auth';
import { useDashboard } from '@/app/dashboard/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  KeyRound,
  Mail,
  Shield,
  Camera,
  Loader2,
  CheckCircle2,
  User,
  Save,
} from 'lucide-react';
import type { UserProfile } from '@/lib/types';

export default function AccountPage() {
  const router = useRouter();
  const { refreshProfile } = useDashboard();

  const token = getAccessToken();
  const jwtUser = token ? parseJwt(token) : null;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Name fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  // Password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);

  useEffect(() => {
    api.auth.getProfile().then((p) => {
      setProfile(p);
      setFirstName(p.firstName ?? '');
      setLastName(p.lastName ?? '');
    }).catch(() => null);
  }, []);

  const handleAvatarClick = () => fileInputRef.current?.click();

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) {
      toast.error('Only JPEG, PNG, WebP or GIF images are allowed');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be smaller than 5 MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => setAvatarPreview(ev.target?.result as string);
    reader.readAsDataURL(file);

    setAvatarUploading(true);
    try {
      const result = await api.auth.uploadAvatar(file);
      setProfile((prev) => prev ? { ...prev, avatarUrl: result.avatarUrl } : prev);
      setAvatarPreview(null);
      refreshProfile(); // sync navbar
      toast.success('Profile photo updated');
    } catch (err: any) {
      setAvatarPreview(null);
      toast.error(err.message || 'Failed to upload photo');
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [refreshProfile]);

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    setSavingName(true);
    setNameSaved(false);
    try {
      const updated = await api.auth.updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });
      setProfile(updated);
      setFirstName(updated.firstName ?? '');
      setLastName(updated.lastName ?? '');
      refreshProfile(); // sync navbar
      setNameSaved(true);
      toast.success('Name updated');
      setTimeout(() => setNameSaved(false), 3000);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update name');
    } finally {
      setSavingName(false);
    }
  }

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
    if (currentPassword === newPassword) {
      toast.error('New password must be different from current password');
      return;
    }

    setSaving(true);
    setPasswordChanged(false);
    try {
      await api.auth.changePassword(currentPassword, newPassword);
      setPasswordChanged(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password changed successfully');
      setTimeout(() => setPasswordChanged(false), 3000);
    } catch (err: any) {
      toast.error(err.message || 'Failed to change password');
    } finally {
      setSaving(false);
    }
  }

  const displayName = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ')
    || jwtUser?.preferred_username
    || jwtUser?.email
    || '';
  const email = profile?.email || jwtUser?.email || '';
  const currentAvatar = avatarPreview || profile?.avatarUrl;
  const initials = profile?.firstName && profile?.lastName
    ? `${profile.firstName[0]}${profile.lastName[0]}`.toUpperCase()
    : displayName.slice(0, 2).toUpperCase() || email.slice(0, 2).toUpperCase();

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
          Manage your profile and security settings
        </p>
      </div>

      {/* Avatar & Profile */}
      <div className="rounded-lg border p-6 space-y-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <User className="h-4 w-4 text-muted-foreground" />
          Profile
        </h2>

        {/* Avatar row */}
        <div className="flex items-center gap-5">
          <div className="relative group shrink-0">
            <button
              type="button"
              onClick={handleAvatarClick}
              disabled={avatarUploading}
              className="relative h-20 w-20 rounded-full overflow-hidden ring-2 ring-border focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {currentAvatar ? (
                <img src={currentAvatar} alt={displayName} className="h-full w-full object-cover" />
              ) : (
                <div className="h-full w-full bg-muted flex items-center justify-center text-xl font-semibold text-muted-foreground">
                  {initials}
                </div>
              )}
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                {avatarUploading
                  ? <Loader2 className="h-5 w-5 text-white animate-spin" />
                  : <Camera className="h-5 w-5 text-white" />}
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">{displayName || '—'}</p>
            <p className="text-xs text-muted-foreground">{email}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={handleAvatarClick}
              disabled={avatarUploading}
            >
              {avatarUploading ? (
                <><Loader2 className="mr-1.5 h-3 w-3 animate-spin" />Uploading...</>
              ) : (
                <><Camera className="mr-1.5 h-3 w-3" />Change photo</>
              )}
            </Button>
            <p className="text-xs text-muted-foreground">JPEG, PNG, WebP or GIF · max 5 MB</p>
          </div>
        </div>

        {/* Name form */}
        <form onSubmit={handleSaveName} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Enter first name"
                maxLength={100}
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Enter last name"
                maxLength={100}
                autoComplete="family-name"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={savingName}>
              {savingName ? (
                <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Saving...</>
              ) : (
                <><Save className="mr-2 h-3.5 w-3.5" />Save Name</>
              )}
            </Button>
            {nameSaved && (
              <span className="flex items-center gap-1.5 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Saved
              </span>
            )}
          </div>
        </form>

        {/* Email row */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Email</Label>
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-4 py-3">
            <div className="flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <p className="text-sm font-medium">{email || '—'}</p>
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
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new">New Password</Label>
            <PasswordInput
              id="new"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
              minLength={6}
              autoComplete="new-password"
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
              autoComplete="new-password"
            />
            {confirmPassword && newPassword !== confirmPassword && (
              <p className="text-xs text-destructive">Passwords do not match</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={saving || !currentPassword || !newPassword || !confirmPassword || newPassword !== confirmPassword}
            >
              {saving ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Changing...</>
              ) : (
                'Change Password'
              )}
            </Button>
            {passwordChanged && (
              <span className="flex items-center gap-1.5 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Password updated
              </span>
            )}
          </div>
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
