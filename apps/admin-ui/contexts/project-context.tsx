'use client';

import { createContext, useContext, ReactNode } from 'react';
import type { Project } from '@/lib/types';

interface ProjectContextValue {
  project: Project | null;
  loading: boolean;
  refreshProject: (() => Promise<void>) | null;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({
  children,
  project,
  loading,
  refreshProject,
}: {
  children: ReactNode;
  project: Project | null;
  loading: boolean;
  refreshProject?: () => Promise<void>;
}) {
  return (
    <ProjectContext.Provider value={{ project, loading, refreshProject: refreshProject ?? null }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (context === undefined) {
    return { project: null, loading: true, refreshProject: null };
  }
  return context;
}
