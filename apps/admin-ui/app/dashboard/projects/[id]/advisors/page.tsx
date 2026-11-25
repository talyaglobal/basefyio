'use client';

import { useParams } from 'next/navigation';
import { ProjectAdvisorsPanel } from '@/components/project-advisors-panel';

export default function ProjectAdvisorsPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <ProjectAdvisorsPanel projectId={id} />
    </div>
  );
}
