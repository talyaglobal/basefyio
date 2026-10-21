'use client';

import { useParams } from 'next/navigation';
import { ProjectBranchesPanel } from '@/components/project-branches-panel';

export default function ProjectBranchesPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <ProjectBranchesPanel projectId={id} />
    </div>
  );
}
