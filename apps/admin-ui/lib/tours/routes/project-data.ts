import type { TourRoute } from '../types';

/** Area "project-data": project overview, data, queries, database, REST API, logs, realtime, embeddings. */
export const ROUTES: TourRoute[] = [
  { id: 'project-overview', kind: 'page', routes: ['/dashboard/projects/[id]'] },
  { id: 'project-tables', kind: 'page', routes: ['/dashboard/projects/[id]/tables'] },
  // One tour for the /sql route: the SQL editor and the JS query editor (NoSQL projects) share it.
  { id: 'project-sql', kind: 'page', routes: ['/dashboard/projects/[id]/sql'] },
  { id: 'project-database', kind: 'page', routes: ['/dashboard/projects/[id]/database'] },
  { id: 'project-api-explorer', kind: 'page', routes: ['/dashboard/projects/[id]/api-explorer'] },
  { id: 'project-logs', kind: 'page', routes: ['/dashboard/projects/[id]/logs'] },
  { id: 'project-realtime', kind: 'page', routes: ['/dashboard/projects/[id]/realtime'] },
  { id: 'project-embeddings', kind: 'page', routes: ['/dashboard/projects/[id]/embeddings'] },
];
