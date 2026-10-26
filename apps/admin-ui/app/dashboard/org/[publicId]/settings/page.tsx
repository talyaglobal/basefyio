'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, Check } from 'lucide-react';
import { api } from '@/lib/api';
import type { OrganizationKind } from '@/lib/types';
import { useDashboard } from '@/app/dashboard/layout';
import { useOrganization } from '@/contexts/organization-context';
import { SELECTABLE_ORGANIZATION_KINDS, kindMeta } from '@/components/organization-kind';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { confirmDialog } from '@/components/ui/confirm-dialog';

export default function OrganizationSettingsPage() {
  const router = useRouter();
  const { organization, refresh } = useOrganization();
  const { teams, refreshTeams, setActiveTeamId } = useDashboard();
  const membership = teams.find((t) => t.id === organization?.id);
  const canEdit = membership?.role === 'OWNER' || membership?.role === 'ADMIN';
  const isOwner = membership?.role === 'OWNER';

  const [name, setName] = useState('');
  const [kind, setKind] = useState<OrganizationKind>('COMPANY');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // Built on the client only, so the server-rendered markup matches.
  const [address, setAddress] = useState('');

  useEffect(() => {
    if (!organization) return;
    setAddress(`${window.location.origin}/dashboard/org/${organization.organizationId}`);
  }, [organization?.organizationId]);

  useEffect(() => {
    if (!organization) return;
    setName(organization.name);
    setKind(organization.kind);
    setDescription(organization.description ?? '');
    setWebsiteUrl(organization.websiteUrl ?? '');
    setLogoUrl(organization.logoUrl ?? '');
  }, [organization?.id, organization?.name, organization?.kind, organization?.description, organization?.websiteUrl, organization?.logoUrl]);

  if (!organization) {
    return <div className="h-40 animate-pulse rounded-xl border bg-muted/30" />;
  }

  async function save() {
    if (!organization) return;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 60) {
      toast.error('Name must be between 2 and 60 characters');
      return;
    }
    setSaving(true);
    try {
      await api.organizations.update(organization.organizationId, {
        ...(trimmed !== organization.name ? { name: trimmed } : {}),
        ...(!organization.isPersonal && kind !== organization.kind ? { kind } : {}),
        description: description.trim() || null,
        websiteUrl: websiteUrl.trim() || null,
        logoUrl: logoUrl.trim() || null,
      });
      toast.success('Organization updated');
      refresh();
      refreshTeams();
    } catch (err: any) {
      toast.error(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy');
    }
  }

  async function remove() {
    if (!organization) return;
    const ok = await confirmDialog({
      title: 'Delete this organization?',
      description:
        'Its members lose access and its settings are gone. The organization must have no projects. This cannot be undone.',
      confirmText: 'Delete organization',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.teams.deleteTeam(organization.id);
      toast.success('Organization deleted');
      const personal = teams.find((t) => t.isPersonal) ?? teams.find((t) => t.id !== organization.id);
      if (personal) {
        setActiveTeamId(personal.id);
        await api.teams.setActive(personal.id).catch(() => {});
      }
      refreshTeams();
      router.push('/dashboard/projects');
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete');
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-4 rounded-xl border p-5">
        <div>
          <h2 className="font-semibold">Profile</h2>
          <p className="text-xs text-muted-foreground">
            {canEdit ? 'What members and invitees see.' : 'Only an owner or an admin can change these.'}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="org-name">Name</Label>
          <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} maxLength={60} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="org-kind">Type</Label>
          {organization.isPersonal ? (
            <p className="text-sm text-muted-foreground">
              {kindMeta('PERSONAL').label} — {kindMeta('PERSONAL').description.toLowerCase()}. Create another organization for a
              company or a team.
            </p>
          ) : (
            <select
              id="org-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as OrganizationKind)}
              disabled={!canEdit}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            >
              {SELECTABLE_ORGANIZATION_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="org-description">Description</Label>
          <Textarea
            id="org-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!canEdit}
            maxLength={512}
            rows={3}
            placeholder="A line about what this organization builds"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="org-website">Website</Label>
            <Input
              id="org-website"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              disabled={!canEdit}
              placeholder="https://"
              maxLength={512}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="org-logo">Logo URL</Label>
            <Input
              id="org-logo"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              disabled={!canEdit}
              placeholder="https://…/logo.png"
              maxLength={1024}
            />
          </div>
        </div>

        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-xl border p-5">
        <div>
          <h2 className="font-semibold">Address</h2>
          <p className="text-xs text-muted-foreground">
            The organization's permanent link. It never changes, even if the name does; share it with members.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 text-xs">{address}</code>
          <Button variant="outline" size="sm" onClick={copyAddress} aria-label="Copy address">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </section>

      {isOwner && !organization.isPersonal && (
        <section className="space-y-3 rounded-xl border border-destructive/40 p-5">
          <div>
            <h2 className="font-semibold text-destructive">Delete organization</h2>
            <p className="text-xs text-muted-foreground">
              Move or delete its projects first. Members lose access the moment it is gone.
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={remove} disabled={organization.counts.projects > 0}>
            Delete organization
          </Button>
          {organization.counts.projects > 0 && (
            <p className="text-xs text-muted-foreground">
              {organization.counts.projects} project{organization.counts.projects === 1 ? '' : 's'} still belong
              {organization.counts.projects === 1 ? 's' : ''} to it.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
