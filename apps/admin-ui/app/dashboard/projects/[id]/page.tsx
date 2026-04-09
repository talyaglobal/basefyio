'use client';

import { useProject } from '@/contexts/project-context';
import { ProjectDetail } from '@/components/project-detail';

export default function ProjectOverviewPage() {
  const { project, loading } = useProject();

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
