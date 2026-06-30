'use client';

import { useProject } from '@/contexts/project-context';
import { StorageBuckets } from '@/components/storage-buckets';
import { Loader2 } from 'lucide-react';

export default function StoragePage() {
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
    <div className="p-6">
      <StorageBuckets projectId={project.id} />
    </div>
  );
}
