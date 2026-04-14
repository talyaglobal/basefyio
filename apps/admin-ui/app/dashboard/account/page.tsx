'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import Cookies from 'js-cookie';
import { api } from '@/lib/api';
import { useDashboard } from '@/app/dashboard/layout';
import type { UserProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  Bell,
  BellRing,
  Camera,
  Check,
  Eye,
  EyeOff,
  Github,
  KeyRound,
  Laptop,
  Link2,
  Loader2,
  Save,
  Unlink,
  User,
  X,
} from 'lucide-react';

export default function AccountPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refreshUser, refreshProfile } = useDashboard();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [pendingAvatarDataUrl, setPendingAvatarDataUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [githubLinking, setGithubLinking] = useState(false);
  const [githubInput, setGithubInput] = useState('');
  const [githubChecking, setGithubChecking] = useState(false);
  const [githubUnlinking, setGithubUnlinking] = useState(false);

  const [notifySignIn, setNotifySignIn] = useState(true);
  const [notifySignInNewDevice, setNotifySignInNewDevice] = useState(false);
  const [notifyTeamInvite, setNotifyTeamInvite] = useState(true);
  const [notifyBrowserPush, setNotifyBrowserPush] = useState(false);
  const [browserPermission, setBrowserPermission] = useState<
    'default' | 'granted' | 'denied' | 'unsupported'
  >('unsupported');
  const [savingNotifs, setSavingNotifs] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const forcePasswordChange = searchParams.get('forcePasswordChange') === '1';

  useEffect(() => {
    if (typeof window !== 'undefined') {
      if ('Notification' in window) {
        setBrowserPermission(Notification.permission);
      } else {
        setBrowserPermission('unsupported');
      }
    }
    api.auth
      .getProfile()
      .then((p) => {
        setProfile(p);
        setUsername(p.username);
        setEmail(p.email);
        setFirstName(p.firstName ?? '');
        setLastName(p.lastName ?? '');
        setAvatarPreview(p.avatarUrl || null);
        setPendingAvatarDataUrl(null);
        setNotifySignIn(p.notifySignIn);
        setNotifySignInNewDevice(p.notifySignInNewDevice ?? false);
        setNotifyTeamInvite(p.notifyTeamInvite);
        setNotifyBrowserPush(p.notifyBrowserPush ?? false);
      })
      .catch(() => toast.error('Failed to load account'))
      .finally(() => setLoading(false));
  }, []);

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Image must be smaller than 2MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setAvatarPreview(dataUrl);
      setPendingAvatarDataUrl(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAvatar = () => {
    setAvatarPreview(null);
    setPendingAvatarDataUrl('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const hasProfileChanges =
    profile &&
    (username !== profile.username ||
      email !== profile.email ||
      firstName.trim() !== (profile.firstName ?? '') ||
      lastName.trim() !== (profile.lastName ?? '') ||
      pendingAvatarDataUrl !== null);
  const authProvider = profile?.authProvider ?? 'local';
  const signOnMethod = profile?.signOnMethod ?? authProvider;
  const isExternalAuth = signOnMethod !== 'local';
  const canEditIdentity = !isExternalAuth || forcePasswordChange;

  const handleSaveProfile = async () => {
    if (!hasProfileChanges) return;
    setSaving(true);
    try {
      const updates: Record<string, string | boolean> = {};
      if (username !== profile!.username) updates.username = username;
      if (email !== profile!.email) updates.email = email;
      const fn = firstName.trim();
      const ln = lastName.trim();
      if (fn !== (profile!.firstName ?? '')) updates.firstName = fn;
      if (ln !== (profile!.lastName ?? '')) updates.lastName = ln;
      if (pendingAvatarDataUrl !== null) updates.avatarUrl = pendingAvatarDataUrl;
      const updated = await api.auth.updateProfile(updates);
      setProfile(updated);
      setAvatarPreview(updated.avatarUrl || null);
      setPendingAvatarDataUrl(null);
      setFirstName(updated.firstName ?? '');
      setLastName(updated.lastName ?? '');
      refreshUser();
      refreshProfile();
      toast.success('Account updated');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update account');
    } finally {
      setSaving(false);
    }
  };

  // const handleLinkGitHub = async () => {
  //   const gh = githubInput.trim();
  //   if (!gh) {
  //     toast.error('Enter a GitHub username');
  //     return;
  //   }
  //   setGithubChecking(true);
  //   try {
  //     const res = await fetch(`https://api.github.com/users/${encodeURIComponent(gh)}`);
  //     if (!res.ok) {
  //       toast.error(`GitHub user "${gh}" not found`);
  //       return;
  //     }
  //     const updated = await api.auth.updateProfile({ githubUsername: gh });
  //     setProfile(updated);
  //     setGithubLinking(false);
  //     setGithubInput('');
  //     toast.success(`GitHub account "${gh}" linked`);
  //     refreshUser();
  //     refreshProfile();
  //   } catch (err: any) {
  //     toast.error(err.message || 'Failed to link GitHub');
  //   } finally {
  //     setGithubChecking(false);
  //   }
  // };

  // const handleUnlinkGitHub = async () => {
  //   setGithubUnlinking(true);
  //   try {
  //     const updated = await api.auth.updateProfile({ githubUsername: '' });
  //     setProfile(updated);
  //     toast.success('GitHub account unlinked');
  //     refreshUser();
  //     refreshProfile();
  //   } catch (err: any) {
  //     toast.error(err.message || 'Failed to unlink GitHub');
  //   } finally {
  //     setGithubUnlinking(false);
  //   }
  // };

  const hasNotifChanges =
    profile &&
    (notifySignIn !== profile.notifySignIn ||
      notifySignInNewDevice !== (profile.notifySignInNewDevice ?? false) ||
      notifyTeamInvite !== profile.notifyTeamInvite ||
      notifyBrowserPush !== (profile.notifyBrowserPush ?? false));

  const handleSaveNotifications = async () => {
    if (!hasNotifChanges) return;
    setSavingNotifs(true);
    try {
      const updates: {
        notifySignIn?: boolean;
        notifySignInNewDevice?: boolean;
        notifyTeamInvite?: boolean;
        notifyBrowserPush?: boolean;
      } = {};
      if (notifySignIn !== profile!.notifySignIn) updates.notifySignIn = notifySignIn;
      if (notifySignInNewDevice !== (profile!.notifySignInNewDevice ?? false)) {
        updates.notifySignInNewDevice = notifySignInNewDevice;
      }
      if (notifyTeamInvite !== profile!.notifyTeamInvite) updates.notifyTeamInvite = notifyTeamInvite;
      if (notifyBrowserPush !== (profile!.notifyBrowserPush ?? false)) {
        updates.notifyBrowserPush = notifyBrowserPush;
      }
      const updated = await api.auth.updateProfile(updates);
      setProfile(updated);
      toast.success('Notification preferences saved');
      refreshProfile();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSavingNotifs(false);
    }
  };

  const requestBrowserPermission = async (): Promise<boolean> => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserPermission('unsupported');
      toast.error('Browser notifications are not supported on this device.');
      return false;
    }
    const next = await Notification.requestPermission();
    setBrowserPermission(next);
    if (next !== 'granted') {
      toast.error('Browser notification permission was not granted.');
      return false;
    }
    return true;
  };

  const handleToggleBrowserPush = async () => {
    if (notifyBrowserPush) {
      setNotifyBrowserPush(false);
      return;
    }
    if (browserPermission === 'granted') {
      setNotifyBrowserPush(true);
      return;
    }
    const granted = await requestBrowserPermission();
    if (granted) {
      setNotifyBrowserPush(true);
      toast.success('Browser notifications enabled');
    }
  };

  const handleSendBrowserTest = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      toast.error('Browser notifications are not supported on this device.');
      return;
    }
    if (Notification.permission !== 'granted') {
      const granted = await requestBrowserPermission();
      if (!granted) return;
    }
    new Notification('Kolaybase', {
      body: 'Browser notifications are active for this account.',
      tag: 'kb-browser-notification-test',
    });
    toast.success('Test browser notification sent');
  };

  const handleChangePassword = async () => {
    if (isExternalAuth) {
      toast.error(`This account must use ${signOnMethod} sign-in. Password change is disabled.`);
      return;
    }
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters and include uppercase, lowercase, number, and special character.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setChangingPassword(true);
    try {
      await api.auth.changePassword(
        newPassword,
        isExternalAuth && canEditIdentity,
      );
      Cookies.remove('kb_force_password_change', { path: '/' });
      toast.success('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (forcePasswordChange) {
        router.replace('/dashboard');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Account not found
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push('/dashboard')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Account</h1>
          <p className="text-sm text-muted-foreground">
            Manage your account settings and preferences
          </p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 space-y-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <User className="h-4 w-4" />
          Account information
        </div>

        <div className="flex items-center gap-5">
          <div className="relative">
            <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-primary/10 ring-2 ring-border">
              {avatarPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarPreview} alt="Avatar" className="h-full w-full object-cover" />
              ) : (
                <User className="h-8 w-8 text-primary" />
              )}
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md hover:bg-primary/90 transition-colors"
            >
              <Camera className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Profile photo</p>
            <p className="text-xs text-muted-foreground">JPG, PNG or GIF. Max 2MB.</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => fileInputRef.current?.click()}>
                Upload
              </Button>
              {avatarPreview && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive hover:text-destructive"
                  onClick={handleRemoveAvatar}
                >
                  <X className="mr-1 h-3 w-3" />
                  Remove
                </Button>
              )}
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarFileChange} />
        </div>

        <Separator />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="account-username">Username</Label>
            <Input
              id="account-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              disabled={!canEditIdentity}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-email">Email</Label>
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              disabled={!canEditIdentity}
            />
          </div>
        </div>
        {isExternalAuth && !canEditIdentity && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <span>
              This account uses {authProvider} sign-in. Username/email and password are locked. You can still update first and last name.
            </span>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="account-first">First name</Label>
            <Input
              id="account-first"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              autoComplete="given-name"
              maxLength={100}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-last">Last name</Label>
            <Input
              id="account-last"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
              autoComplete="family-name"
              maxLength={100}
            />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">{profile.role}</Badge>
            <Badge variant="outline" className="text-xs uppercase">{authProvider}</Badge>
          </div>
          <Button onClick={handleSaveProfile} disabled={!hasProfileChanges || saving} size="sm">
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
            Save changes
          </Button>
        </div>
      </div>

       {/* <div className="rounded-lg border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Github className="h-4 w-4" />
          GitHub account
        </div>

        {profile.githubUsername ? (
          <div className="flex items-center justify-between rounded-md border bg-muted/30 p-4">
            <div className="flex items-center gap-3">
              <img
                src={`https://github.com/${profile.githubUsername}.png?size=80`}
                alt={profile.githubUsername}
                className="h-10 w-10 rounded-full ring-2 ring-border"
              />
              <div>
                <a
                  href={`https://github.com/${profile.githubUsername}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium hover:underline flex items-center gap-1"
                >
                  {profile.githubUsername}
                  <Github className="h-3 w-3" />
                </a>
                <p className="text-xs text-muted-foreground">Connected</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={handleUnlinkGitHub}
              disabled={githubUnlinking}
            >
              {githubUnlinking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Unlink className="mr-1.5 h-3.5 w-3.5" />}
              Unlink
            </Button>
          </div>
        ) : githubLinking ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Enter your GitHub username to link your account.
            </p>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  github.com/
                </span>
                <Input
                  value={githubInput}
                  onChange={(e) => setGithubInput(e.target.value)}
                  placeholder="username"
                  className="pl-[96px]"
                  onKeyDown={(e) => e.key === 'Enter' && handleLinkGitHub()}
                />
              </div>
              <Button onClick={handleLinkGitHub} disabled={githubChecking || !githubInput.trim()} size="sm">
                {githubChecking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                Link
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setGithubLinking(false); setGithubInput(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-md border border-dashed p-4">
            <div>
              <p className="text-sm font-medium">No GitHub account linked</p>
              <p className="text-xs text-muted-foreground">Link your GitHub to show on your profile</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setGithubLinking(true)}>
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              Link GitHub
            </Button>
          </div>
        )}
      </div> */}

      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bell className="h-4 w-4" />
          Email notifications
        </div>
        <p className="text-xs text-muted-foreground">
          Choose which email notifications you want to receive.
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-md border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Email on every sign-in</p>
              <p className="text-xs text-muted-foreground">
                Send an email every time your account signs in.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setNotifySignIn(!notifySignIn)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                notifySignIn ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  notifySignIn ? 'translate-x-[22px]' : 'translate-x-[2px]'
                } mt-[2px]`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between rounded-md border px-4 py-3">
            <div className="pr-4">
              <p className="text-sm font-medium">Email only for new device/browser</p>
              <p className="text-xs text-muted-foreground">
                Send email only when sign-in fingerprint changes (new device or browser).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setNotifySignInNewDevice(!notifySignInNewDevice)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                notifySignInNewDevice ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  notifySignInNewDevice ? 'translate-x-[22px]' : 'translate-x-[2px]'
                } mt-[2px]`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between rounded-md border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Team invitations</p>
              <p className="text-xs text-muted-foreground">
                Get notified when you are invited to a team
              </p>
            </div>
            <button
              type="button"
              onClick={() => setNotifyTeamInvite(!notifyTeamInvite)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                notifyTeamInvite ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  notifyTeamInvite ? 'translate-x-[22px]' : 'translate-x-[2px]'
                } mt-[2px]`}
              />
            </button>
          </div>

          <div className="space-y-3 rounded-md border px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="pr-4">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <BellRing className="h-3.5 w-3.5" />
                  Browser notifications
                </p>
                <p className="text-xs text-muted-foreground">
                  Show in-browser notifications for account security events.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleToggleBrowserPush()}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                  notifyBrowserPush ? 'bg-primary' : 'bg-muted'
                }`}
                disabled={browserPermission === 'unsupported'}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    notifyBrowserPush ? 'translate-x-[22px]' : 'translate-x-[2px]'
                  } mt-[2px]`}
                />
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Laptop className="h-3.5 w-3.5" />
                Permission: {browserPermission}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void handleSendBrowserTest()}
                disabled={browserPermission === 'unsupported'}
              >
                Send test
              </Button>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSaveNotifications} disabled={!hasNotifChanges || savingNotifs} size="sm">
            {savingNotifs ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
            Save preferences
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4" />
          Change password
        </div>
        {forcePasswordChange && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Your password was reset by an administrator. You must set a new password to continue.
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {isExternalAuth
            ? `Social sign-in account (${signOnMethod}). Password sign-in is disabled for this account.`
            : 'Set a new password (minimum 8 characters, with uppercase, lowercase, number, and special character).'}
        </p>

        {!isExternalAuth ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="account-new-pw">New password</Label>
              <div className="relative">
                <Input
                  id="account-new-pw"
                  type={showNewPw ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 8 chars + uppercase/lowercase/number/special"
                  className="pr-10"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw(!showNewPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-confirm-pw">Confirm new password</Label>
              <div className="relative">
                <Input
                  id="account-confirm-pw"
                  type={showConfirmPw ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat new password"
                  className="pr-10"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPw(!showConfirmPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showConfirmPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          {newPassword && confirmPassword && newPassword !== confirmPassword && (
            <p className="text-xs text-destructive">Passwords do not match</p>
          )}
        </div>
        ) : (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            This user can only sign in with {signOnMethod}. Password setup/change is disabled.
          </div>
        )}

        <div className="flex justify-end">
          <Button
            onClick={handleChangePassword}
            disabled={
              changingPassword ||
              isExternalAuth ||
              newPassword.length < 8 ||
              newPassword !== confirmPassword
            }
            size="sm"
          >
            {changingPassword ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <KeyRound className="mr-1.5 h-3.5 w-3.5" />}
            Change password
          </Button>
        </div>
      </div>
    </div>
  );
}
