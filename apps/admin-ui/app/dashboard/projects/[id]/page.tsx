'use client';

import Link from 'next/link';
import { useProject } from '@/contexts/project-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { HardDrive, Loader2, Terminal } from 'lucide-react';

function InfoRow({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <div className="flex items-start justify-between py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-4 max-w-[60%] truncate text-right font-mono">{value ?? '—'}</span>
    </div>
  );
}

function formatDate(d: string): string {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ProjectOverviewPage() {
  const { project, loading } = useProject();

  if (loading && !project) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant={project.status === 'ACTIVE' ? 'default' : 'outline'}>{project.status}</Badge>
            <span className="text-xs text-muted-foreground">{project.slug}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/dashboard/projects/${project.id}/sql`}>
              <Terminal className="mr-1.5 h-4 w-4" />
              SQL Editor
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`/dashboard/projects/${project.id}/storage`}>
              <HardDrive className="mr-1.5 h-4 w-4" />
              Storage
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold mb-2">Project</h2>
          <Separator className="mb-3" />
          <InfoRow label="ID" value={project.id} />
          <InfoRow label="Slug" value={project.slug} />
          <InfoRow label="Region" value={project.region} />
          <InfoRow label="Team" value={project.teamId} />
          <InfoRow label="Created" value={formatDate(project.createdAt)} />
          <InfoRow label="Updated" value={formatDate(project.updatedAt)} />
        </div>

        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold mb-2">Database</h2>
          <Separator className="mb-3" />
          <InfoRow label="Host" value={project.dbHost} />
          <InfoRow label="Port" value={project.dbPort} />
          <InfoRow label="Database" value={project.dbName} />
          <InfoRow label="User" value={project.dbUser} />
        </div>
      </div>
    </div>
  );
}
