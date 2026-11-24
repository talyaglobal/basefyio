import type { TourRoute } from '../types';

/** Area "workspace": dashboard pages outside a project (overview, projects, account, team, billing...). */
export const ROUTES: TourRoute[] = [
  { id: 'overview', kind: 'page', routes: ['/dashboard'] },
  { id: 'projects', kind: 'page', routes: ['/dashboard/projects'] },
  { id: 'blueprints', kind: 'page', routes: ['/dashboard/blueprints'] },
  { id: 'blueprint-detail', kind: 'page', routes: ['/dashboard/blueprints/[id]'] },
  { id: 'account', kind: 'page', routes: ['/dashboard/account'] },
  { id: 'api-tokens', kind: 'page', routes: ['/dashboard/account/api-tokens'] },
  {
    id: 'api-token-form',
    kind: 'page',
    routes: ['/dashboard/account/api-tokens/new', '/dashboard/account/api-tokens/[id]/edit'],
  },
  // With organizations_ui on, /dashboard/team redirects to the members page and the same screen renders there.
  { id: 'team', kind: 'page', routes: ['/dashboard/team', '/dashboard/org/[publicId]/members'] },
  // Same redirect as the team page: with organizations_ui on, billing renders under the organization.
  { id: 'billing', kind: 'page', routes: ['/dashboard/billing', '/dashboard/org/[publicId]/billing'] },
  { id: 'org-overview', kind: 'page', routes: ['/dashboard/org/[publicId]'], when: { flagOn: 'organizations_ui' } },
  { id: 'org-projects', kind: 'page', routes: ['/dashboard/org/[publicId]/projects'], when: { flagOn: 'organizations_ui' } },
  { id: 'org-settings', kind: 'page', routes: ['/dashboard/org/[publicId]/settings'], when: { flagOn: 'organizations_ui' } },
  { id: 'org-new', kind: 'page', routes: ['/dashboard/org/new'], when: { flagOn: 'organizations_ui' } },
  { id: 'feedbacks', kind: 'page', routes: ['/dashboard/feedbacks'] },
];
