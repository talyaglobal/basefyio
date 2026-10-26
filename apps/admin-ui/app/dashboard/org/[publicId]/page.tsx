'use client';

import Link from 'next/link';
import { FolderOpen, Mail, Users, CreditCard, ExternalLink } from 'lucide-react';
import { useOrganization } from '@/contexts/organization-context';
import { orgPath } from '@/app/dashboard/layout';
import { Button } from '@/components/ui/button';

function Stat({
  label,
  value,
  hint,
  href,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  href: string;
  icon: React.ElementType;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <Icon className="h-4 w-4 opacity-70 group-hover:opacity-100" aria-hidden="true" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </Link>
  );
}

export default function OrganizationOverviewPage() {
  const { organization, loading } = useOrganization();

  if (loading && !organization) {
    return <div className="h-40 animate-pulse rounded-xl border bg-muted/30" />;
  }
  if (!organization) return null;

  const base = orgPath({ id: organization.id, publicId: organization.publicId });
  const { counts } = organization;
  const projectsHint =
    counts.projectsDeactivated > 0
      ? `${counts.projectsAwake} active · ${counts.projectsDeactivated} deactivated`
      : counts.projects === 0
        ? 'No projects yet'
        : 'All active';

  return (
    <div className="space-y-6">
      {organization.description && (
        <p className="max-w-2xl text-sm text-muted-foreground">{organization.description}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Projects" value={counts.projects} hint={projectsHint} href={`${base}/projects`} icon={FolderOpen} />
        <Stat
          label="Members"
          value={counts.members}
          hint={counts.members === 1 ? 'Just you' : undefined}
          href={`${base}/members`}
          icon={Users}
        />
        <Stat
          label="Pending invites"
          value={counts.pendingInvites}
          hint={counts.pendingInvites === 0 ? 'Nobody waiting' : 'Waiting to join'}
          href={`${base}/members`}
          icon={Mail}
        />
        <Stat
          label="Plan"
          value={organization.plan?.displayName ?? 'Free'}
          hint="Usage, invoices and upgrades"
          href={`${base}/billing`}
          icon={CreditCard}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href="/dashboard/projects">Open projects</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`${base}/members`}>Invite a member</Link>
        </Button>
        {organization.websiteUrl && (
          <Button asChild size="sm" variant="ghost">
            <a href={organization.websiteUrl} target="_blank" rel="noreferrer noopener">
              Website <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
