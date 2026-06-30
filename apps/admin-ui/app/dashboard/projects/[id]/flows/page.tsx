'use client';

import { useParams } from 'next/navigation';
import { ProjectFlows } from '@/components/project-flows';

export default function FlowsPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectFlows projectId={id} />;
}
