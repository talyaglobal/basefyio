'use client';

import { useParams } from 'next/navigation';
import { ProjectAuth } from '@/components/project-auth';

export default function AuthPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectAuth projectId={id} />;
}
