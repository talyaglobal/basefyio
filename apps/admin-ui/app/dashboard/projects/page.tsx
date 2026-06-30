'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { Project } from '@basefyio/sdk';
import { getSdk } from '@/lib/sdk';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { Database, Loader2, Plus, RefreshCw } from 'lucide-react';

function statusVariant(status: Project['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ACTIVE') return 'default';
  if (status === 'DELETED') return 'destructive';
  return 'outline';
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSdk().projects.list();
      setProjects(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load projects';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function handleCreated(project: Project) {
    setProjects((prev) => [project, ...prev]);
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {loading ? 'Loading...' : `${projects.length} project${projects.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { void load(); }} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <CreateProjectDialog onCreated={handleCreated}>
            <Button size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              New project
            </Button>
          </CreateProjectDialog>
        </div>
      </div>

      {loading && projects.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => { void load(); }}>
            Try again
          </Button>
        </div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
          <Database className="mb-4 h-12 w-12 text-muted-foreground/40" />
          <h3 className="text-lg font-medium">No projects yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create your first project to get started.</p>
          <CreateProjectDialog onCreated={handleCreated}>
            <Button className="mt-4">
              <Plus className="mr-1.5 h-4 w-4" />
              Create project
            </Button>
          </CreateProjectDialog>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/dashboard/projects/${project.id}`}
              className="group rounded-lg border bg-card p-5 shadow-sm transition-colors hover:border-primary/50 hover:bg-card/80"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <Database className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium group-hover:text-primary">{project.name}</span>
                </div>
                <Badge variant={statusVariant(project.status)} className="ml-2 shrink-0 text-xs">
                  {project.status}
                </Badge>
              </div>
              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                <p className="truncate">ID: {project.id}</p>
                <p>Created {formatDate(project.createdAt)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
