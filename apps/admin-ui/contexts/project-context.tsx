'use client';

import { createContext, useContext, ReactNode } from 'react';
import type { Project } from '@/lib/types';

interface ProjectContextValue {
  project: Project | null;
  loading: boolean;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({
  children,
  project,
  loading,
}: {
  children: ReactNode;
  project: Project | null;
  loading: boolean;
}) {
  return (
    <ProjectContext.Provider value={{ project, loading }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (context === undefined) {
    return { project: null, loading: true };
  }
  return context;
}
