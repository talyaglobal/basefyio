'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import type { Project } from '@basefyio/sdk';
import { getSdk } from '@/lib/sdk';
import { ProjectContext } from '@/contexts/project-context';
import { AppSidebar } from '@/components/app-sidebar';
import { Loader2 } from 'lucide-react';

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await getSdk().projects.get(id);
      setProject(data);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <ProjectContext.Provider value={{ project, loading, refresh }}>
      <div className="flex h-screen overflow-hidden">
        <AppSidebar projectId={id} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {loading && !project ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </ProjectContext.Provider>
  );
}
