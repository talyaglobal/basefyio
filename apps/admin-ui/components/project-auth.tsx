'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { RealmInfo, RealmUser, ProjectAuthConfig } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Check,
  Copy,
  Eye,
  Info,
  KeyRound,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  Shield,
  Trash2,
  Users,
} from 'lucide-react';

interface ProjectAuthProps {
  projectId: string;
}

type TabId = 'users' | 'settings' | 'email';

export function ProjectAuth({ projectId }: ProjectAuthProps) {
  const [activeTab, setActiveTab] = useState<TabId>('users');
  const [realm, setRealm] = useState<RealmInfo | null>(null);
  const [users, setUsers] = useState<RealmUser[]>([]);
  const [config, setConfig] = useState<ProjectAuthConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [r, u, c] = await Promise.all([
        api.projects.realmInfo(projectId),
        api.projects.realmUsers(projectId),
        api.projects.getAuthConfig(projectId),
      ]);
      setRealm(r);
      setUsers(u);
      setConfig(c);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'users', label: 'Users', icon: <Users className="h-3.5 w-3.5" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="h-3.5 w-3.5" /> },
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
        <div className="grid gap-4 sm:grid-cols-3">
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
              <p>Signup: <Badge variant="outline" className="ml-1 font-mono text-xs">POST /rest/v1/auth/signup</Badge></p>
              <p>Signin: <Badge variant="outline" className="ml-1 font-mono text-xs">POST /rest/v1/auth/signin</Badge></p>
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
          projectId={projectId}
          onRefresh={loadAll}
        />
      )}
      {activeTab === 'settings' && config && (
        <SettingsTab projectId={projectId} config={config} onSaved={setConfig} />
      )}
      {activeTab === 'email' && config && (
        <EmailTab projectId={projectId} config={config} onSaved={setConfig} />
      )}

      <CreateUserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        onCreated={loadAll}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────── Users Tab */
function UsersTab({
  users,
  projectId,
  onRefresh,
}: {
  users: RealmUser[];
  projectId: string;
  onRefresh: () => void;
}) {
  async function handleDelete(userId: string, email: string) {
    if (!confirm(`Delete user "${email}"?`)) return;
    try {
      await api.projects.deleteRealmUser(projectId, userId);
      toast.success('User deleted');
      onRefresh();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  if (users.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed">
        <Users className="mb-3 h-10 w-10 text-muted-foreground/50" />
        <p className="font-medium">No users yet</p>
        <p className="text-sm text-muted-foreground">
          Users can sign up via SDK or be added manually above.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-4 py-2 text-left font-medium">Email</th>
            <th className="px-4 py-2 text-left font-medium">Name</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b last:border-0">
              <td className="px-4 py-2 font-medium">{u.email}</td>
              <td className="px-4 py-2 text-muted-foreground">
                {[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}
              </td>
              <td className="px-4 py-2">
                <Badge variant={u.enabled ? 'default' : 'secondary'}>
                  {u.enabled ? 'Active' : 'Disabled'}
                </Badge>
              </td>
              <td className="px-4 py-2 text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => handleDelete(u.id, u.email)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────────────────────────────────────────── Settings Tab */
function SettingsTab({
  projectId,
  config,
  onSaved,
}: {
  projectId: string;
  config: ProjectAuthConfig;
  onSaved: (c: ProjectAuthConfig) => void;
}) {
  const [selfSignup, setSelfSignup] = useState(config.allowSignup);
  const [emailVerification, setEmailVerification] = useState(config.requireEmailVerify);
  const [minPwLen, setMinPwLen] = useState(String(config.minPasswordLength));
  const [tokenExpiry, setTokenExpiry] = useState(String(config.tokenExpirySeconds));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await api.projects.updateAuthConfig(projectId, {
        allowSignup: selfSignup,
        requireEmailVerify: emailVerification,
        minPasswordLength: parseInt(minPwLen, 10) || 6,
        tokenExpirySeconds: parseInt(tokenExpiry, 10) || 1800,
      });
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
          description="Users can create accounts via SDK (kb.auth.signUp)"
          checked={selfSignup}
          onChange={setSelfSignup}
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

      <div className="rounded-lg border p-6 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Shield className="h-4 w-4 text-muted-foreground" />
          Password Policy
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Minimum length</Label>
            <Input type="number" value={minPwLen} onChange={(e) => setMinPwLen(e.target.value)} min={6} max={128} />
          </div>
          <div className="space-y-1.5">
            <Label>Token expiry (seconds)</Label>
            <Input type="number" value={tokenExpiry} onChange={(e) => setTokenExpiry(e.target.value)} min={300} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
        <Info className="h-4 w-4 shrink-0" />
        <p>Settings are saved per-project. Changes will take effect immediately for new auth requests.</p>
      </div>

      <Button onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Settings'}
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
  const [smtpHost, setSmtpHost] = useState(config.smtpHost || '');
  const [smtpPort, setSmtpPort] = useState(String(config.smtpPort || 587));
  const [smtpUser, setSmtpUser] = useState(config.smtpUser || '');
  const [smtpPass, setSmtpPass] = useState('');
  const [senderEmail, setSenderEmail] = useState(config.senderEmail || '');
  const [senderName, setSenderName] = useState(config.senderName || '');
  const [saving, setSaving] = useState(false);

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
      {/* SMTP Configuration */}
      <div className="rounded-lg border p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Server className="h-4 w-4 text-muted-foreground" />
            SMTP Configuration
          </h3>
          <Badge variant="secondary">Optional</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          By default, emails are sent via Kolaybase&apos;s built-in email service (Resend).
          Configure custom SMTP to send emails from your own domain.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>SMTP Host</Label>
            <Input placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>SMTP Port</Label>
            <Input placeholder="587" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Username</Label>
            <Input placeholder="user@example.com" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Password</Label>
            <Input type="password" placeholder={config.smtpPass ? '••••••••  (saved)' : 'Enter password'} value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Sender Email</Label>
            <Input placeholder="noreply@yourapp.com" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Sender Name</Label>
            <Input placeholder="My App" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
          </div>
        </div>

        <Button
          disabled={!smtpHost || saving}
          onClick={async () => {
            setSaving(true);
            try {
              const payload: Record<string, any> = {
                smtpHost: smtpHost || null,
                smtpPort: parseInt(smtpPort, 10) || 587,
                smtpUser: smtpUser || null,
                senderEmail: senderEmail || null,
                senderName: senderName || null,
              };
              if (smtpPass) payload.smtpPass = smtpPass;
              const updated = await api.projects.updateAuthConfig(projectId, payload);
              onSaved(updated);
              setSmtpPass('');
              toast.success('SMTP settings saved');
            } catch (err: any) {
              toast.error(err.message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Saving...' : 'Save SMTP Settings'}
        </Button>
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
    '{{verify_url}}': 'https://api.kolaybase.com/rest/v1/auth/verify-email-callback?otp=482917',
    '{{email}}': 'user@example.com',
    '{{invite_url}}': 'https://api.kolaybase.com/rest/v1/auth/invite-callback?otp=482917',
    '{{magic_link_url}}': 'https://api.kolaybase.com/rest/v1/auth/magic-link-callback?otp=482917',
    '{{confirm_url}}': 'https://api.kolaybase.com/rest/v1/auth/change-email-callback?otp=482917',
    '{{new_email}}': 'newemail@example.com',
  };

  function applyVars(text: string) {
    return Object.entries(previewVars).reduce((s, [k, v]) => s.replaceAll(k, v), text);
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
                <div className="border-t pt-2" dangerouslySetInnerHTML={{ __html: applyVars(body) }} />
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

  const code = `import { createClient } from 'kolaybase-js'

const kb = createClient({
  projectId: 'YOUR_PROJECT_ID',
  apiKey: 'YOUR_ANON_KEY',
})

// Sign up
const { data, error } = await kb.auth.signUp({
  email: 'user@example.com',
  password: 'securepass',
})

// Verify email (6-digit OTP from email)
await kb.auth.verifyEmail('123456')

// Sign in
await kb.auth.signIn({
  email: 'user@example.com',
  password: 'securepass',
})

// Magic link (passwordless)
await kb.auth.sendMagicLink('user@example.com')
await kb.auth.verifyMagicLink('123456')

// Change email
await kb.auth.changeEmail('new@example.com')
await kb.auth.confirmChangeEmail('123456')

// Forgot password
await kb.auth.forgotPassword('user@example.com')

// Reset password
await kb.auth.resetPassword('123456', 'newSecurePass')

// Reauthentication (for sensitive actions)
await kb.auth.requestReauth()
await kb.auth.verifyReauth('123456')

// Invite user (requires service_role key)
await kb.auth.inviteUser('newuser@example.com')

// Get current user
const { data: user } = await kb.auth.getUser()`;

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
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
  });
  const [saving, setSaving] = useState(false);

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.projects.createRealmUser(projectId, form);
      toast.success('User created');
      setForm({ email: '', password: '', firstName: '', lastName: '' });
      onOpenChange(false);
      onCreated();
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
          <DialogTitle>Create User</DialogTitle>
          <DialogDescription>
            Add a new user to this project&apos;s auth realm.
            The user will have emailVerified: true (admin-created).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cu-first">First Name</Label>
              <Input id="cu-first" value={form.firstName} onChange={(e) => update('firstName', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cu-last">Last Name</Label>
              <Input id="cu-last" value={form.lastName} onChange={(e) => update('lastName', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-email">Email *</Label>
            <Input id="cu-email" type="email" value={form.email} onChange={(e) => update('email', e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-pass">Password *</Label>
            <Input id="cu-pass" type="password" value={form.password} onChange={(e) => update('password', e.target.value)} required minLength={6} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Creating...' : 'Create User'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
