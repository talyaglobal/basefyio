import type { TourRoute } from '../types';

/** Area "workspace": dashboard pages outside a project (overview, projects, account, team, billing...). */
export const ROUTES: TourRoute[] = [
  { id: 'projects', kind: 'page', routes: ['/dashboard/projects'] },
];
