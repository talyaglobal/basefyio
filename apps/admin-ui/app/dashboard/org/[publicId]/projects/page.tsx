'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { OrganizationProject } from '@/lib/types';
import { useOrganization } from '@/contexts/organization-context';
import { cn, projectStatusBadgeClass, projectStatusLabel } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export default function OrganizationProjectsPage() {
  const { organization } = useOrganization();
  const [projects, setProjects] = useState<OrganizationProject[] | null>(null);

  useEffect(() => {
    if (!organization) return;
    let cancelled = false;
    api.organizations
      .projects(organization.organizationId)
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [organization?.organizationId]);

  if (!organization || projects === null) {
    return <div className="h-40 animate-pulse rounded-xl border bg-muted/30" />;
  }

  if (projects.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="text-sm text-muted-foreground">No projects in this organization yet.</p>
        <Button asChild size="sm" className="mt-4">
          <Link href="/dashboard/projects">Create the first one</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Project</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Database</th>
            <th className="px-4 py-2 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className="border-t hover:bg-accent/40">
              <td className="px-4 py-2">
                <Link href={`/dashboard/projects/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </Link>
                <div className="text-xs text-muted-foreground">{p.slug}</div>
              </td>
              <td className="px-4 py-2">
                <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', projectStatusBadgeClass(p.status))}>
                  {projectStatusLabel(p.status)}
                </span>
              </td>
              <td className="px-4 py-2 text-muted-foreground">{p.databaseType === 'NOSQL' ? 'Document' : 'Relational'}</td>
              <td className="px-4 py-2 text-muted-foreground">{new Date(p.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
