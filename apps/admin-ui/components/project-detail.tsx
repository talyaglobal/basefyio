'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Database, Key, Shield, Trash2 } from 'lucide-react';

interface ProjectDetailProps {
  project: Project;
}

export function ProjectDetail({ project }: ProjectDetailProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm(`Delete "${project.name}"? This cannot be undone.`)) return;

    setDeleting(true);
    try {
      await api.projects.delete(project.id);
      toast.success('Project deleted');
      router.push('/dashboard');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
          {project.description && (
            <p className="mt-1 text-muted-foreground">{project.description}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Created {new Date(project.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={project.status === 'ACTIVE' ? 'default' : 'secondary'}>
            {project.status}
          </Badge>
          <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
            <Trash2 className="mr-2 h-4 w-4" />
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>

      <Separator />

      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Database className="h-4 w-4" />
            Database
          </div>
          <p className="mt-2 font-mono text-sm">{project.dbName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {project.dbHost}:{project.dbPort}
          </p>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Shield className="h-4 w-4" />
            Keycloak Realm
          </div>
          <p className="mt-2 font-mono text-sm">{project.keycloakRealm}</p>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Key className="h-4 w-4" />
            Anon Key
          </div>
          <p className="mt-2 truncate font-mono text-sm" title={project.anonKey}>
            {project.anonKey}
          </p>
        </div>
      </div>
    </div>
  );
}
