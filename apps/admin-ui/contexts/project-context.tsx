'use client';

import { createContext, useContext } from 'react';
import type { Project } from '@basefyio/sdk';

interface ProjectContextValue {
  project: Project | null;
  loading: boolean;
  refresh: () => void;
}

export const ProjectContext = createContext<ProjectContextValue>({
  project: null,
  loading: true,
  refresh: () => {},
});

export function useProject(): ProjectContextValue {
  return useContext(ProjectContext);
}
