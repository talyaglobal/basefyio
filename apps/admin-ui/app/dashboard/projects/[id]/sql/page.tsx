'use client';

import { useProject } from '@/contexts/project-context';
import { SqlEditor } from '@/components/sql-editor';
import { Loader2 } from 'lucide-react';

export default function SqlPage() {
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
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <h1 className="mb-4 text-lg font-semibold">SQL Editor</h1>
      <SqlEditor projectId={project.id} />
    </div>
  );
}
