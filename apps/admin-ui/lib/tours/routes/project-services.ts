import type { TourRoute } from '../types';

/** Area "project-services": auth, storage, connect, integrations, flows, branches, backup, settings. */
export const ROUTES: TourRoute[] = [
  { id: 'project-auth', kind: 'page', routes: ['/dashboard/projects/[id]/auth'] },
  { id: 'project-storage', kind: 'page', routes: ['/dashboard/projects/[id]/storage'] },
  { id: 'project-connect', kind: 'page', routes: ['/dashboard/projects/[id]/connect'] },
  { id: 'project-integrations', kind: 'page', routes: ['/dashboard/projects/[id]/integrations'] },
  { id: 'project-flows', kind: 'page', routes: ['/dashboard/projects/[id]/flows'] },
  { id: 'project-branches', kind: 'page', routes: ['/dashboard/projects/[id]/branches'] },
  // One tour and one "seen" record for both routes: /backup re-renders the export page.
  {
    id: 'project-backup',
    kind: 'page',
    routes: ['/dashboard/projects/[id]/export', '/dashboard/projects/[id]/backup'],
  },
  { id: 'project-settings', kind: 'page', routes: ['/dashboard/projects/[id]/settings'] },
];
