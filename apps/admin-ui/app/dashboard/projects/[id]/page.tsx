'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import { ProjectDetail } from '@/components/project-detail';

export default function ProjectOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const recoverProjectWithTeamSwitch = useCallback(
    async (projectId: string) => {
      const teams = await api.teams.list();
      for (const team of teams) {
        try {
          await api.teams.setActive(team.id);
          Cookies.set('kb_active_team', team.id, { expires: 365, path: '/' });
          const loaded = await api.projects.get(projectId);
          return loaded;
        } catch {
          // Try next team.
        }
      }
      return null;
    },
    [],
  );

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.projects
      .get(id)
      .then(setProject)
      .catch(async (err) => {
        const recovered = await recoverProjectWithTeamSwitch(id);
        if (recovered) {
          setProject(recovered);
          return;
        }
        toast.error(err.message || 'Failed to load project');
        router.push('/dashboard/projects');
      })
      .finally(() => setLoading(false));
  }, [id, router, recoverProjectWithTeamSwitch]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!project) {
    return <p className="text-muted-foreground">Project not found.</p>;
  }

  return <ProjectDetail project={project} />;
}
