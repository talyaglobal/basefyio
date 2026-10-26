'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { OrganizationOverview } from '@/lib/types';
import { useDashboard, orgPath } from '@/app/dashboard/layout';
import { OrganizationContext } from '@/contexts/organization-context';
import { OrganizationKindBadge, OrganizationKindIcon } from '@/components/organization-kind';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const TABS = [
  { sub: '', label: 'Overview' },
  { sub: '/projects', label: 'Projects' },
  { sub: '/members', label: 'Members' },
  { sub: '/billing', label: 'Billing' },
  { sub: '/settings', label: 'Settings' },
];

/**
 * /dashboard/org/[publicId]: the organization's shareable address. Opening it
 * makes that organization the active one, the way a project route does, so
 * the pages underneath (members, billing) that read the active team show the
 * right organization.
 */
export default function OrganizationLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ publicId: string }>();
  const publicId = params?.publicId ?? '';
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { activeTeamId, setActiveTeamId, features, featuresLoaded, refreshKey } = useDashboard();

  const [organization, setOrganization] = useState<OrganizationOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    if (!publicId) return;
    try {
      const org = await api.organizations.get(publicId);
      setOrganization(org);
      setMissing(false);
    } catch (err: any) {
      if (err?.status === 404 || err?.status === 403) setMissing(true);
    } finally {
      setLoading(false);
    }
  }, [publicId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Off means these pages do not exist yet; the team pages carry on.
  useEffect(() => {
    if (featuresLoaded && !features.organizations_ui) router.replace('/dashboard/projects');
  }, [featuresLoaded, features.organizations_ui, router]);

  useEffect(() => {
    if (!organization || organization.id === activeTeamId) return;
    setActiveTeamId(organization.id);
    void api.teams.setActive(organization.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id]);

  const base = orgPath(organization ? { id: organization.id, publicId: organization.publicId } : { id: publicId, publicId });
  const contextValue = useMemo(
    () => ({ organization, loading, refresh: () => void load() }),
    [organization, loading, load],
  );

  if (missing) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center space-y-4">
        <h1 className="text-xl font-semibold">Organization not found</h1>
        <p className="text-sm text-muted-foreground">
          This link does not point to an organization you belong to. Ask the owner for an invite, or pick one of yours
          from the switcher.
        </p>
        <Button variant="outline" onClick={() => router.push('/dashboard/projects')}>
          Back to projects
        </Button>
      </div>
    );
  }

  return (
    <OrganizationContext.Provider value={contextValue}>
      <div className="space-y-6">
        <header className="flex flex-wrap items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-sm shrink-0">
            {organization ? (
              <OrganizationKindIcon kind={organization.kind} className="h-6 w-6" />
            ) : (
              <span className="h-6 w-6 animate-pulse rounded bg-white/40" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {organization?.name ?? (loading ? 'Loading…' : 'Organization')}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {organization && <OrganizationKindBadge kind={organization.kind} />}
              {organization?.isPersonal && (
                <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium">Personal</span>
              )}
              {organization?.plan && (
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  {organization.plan.displayName}
                </span>
              )}
              {organization?.organizationId && (
                <span className="font-mono text-[11px]" title="The organization's address; share it with members">
                  {organization.organizationId}
                </span>
              )}
            </div>
          </div>
        </header>

        <nav className="flex gap-1 overflow-x-auto border-b" aria-label="Organization sections">
          {TABS.map((tab) => {
            const href = `${base}${tab.sub}`;
            const active = tab.sub === '' ? pathname === base : pathname.startsWith(href);
            return (
              <Link
                key={tab.sub || 'overview'}
                href={href}
                className={cn(
                  '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
                  active
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        {children}
      </div>
    </OrganizationContext.Provider>
  );
}
