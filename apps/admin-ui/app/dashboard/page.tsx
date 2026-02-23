'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ProjectListItem } from '@/lib/types';
import { ProjectList } from '@/components/project-list';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { Button } from '@/components/ui/button';
import { Plus, RefreshCw } from 'lucide-react';

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function loadProjects() {
    setLoading(true);
    try {
      const data = await api.projects.list();
      setProjects(data);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  function handleCreated() {
    setDialogOpen(false);
    loadProjects();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground">
            Manage your databases, auth realms, and APIs.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={loadProjects}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </Button>
        </div>
      </div>

      <ProjectList projects={projects} loading={loading} onRefresh={loadProjects} />

      <CreateProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
      />
    </div>
  );
}
