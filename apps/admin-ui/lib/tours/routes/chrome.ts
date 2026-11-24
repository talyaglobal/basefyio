import type { TourRoute } from '../types';

/**
 * Area "chrome": the frame around the pages. The workspace header and sidebar (`shell`) and the
 * project sidebar (`project-shell`). A chrome tour goes before the page's own tour.
 */
export const ROUTES: TourRoute[] = [
  {
    id: 'shell',
    kind: 'chrome',
    routes: ['/dashboard/**'],
    except: [
      '/dashboard/projects/[id]/**',
      '/dashboard/admin/**',
      '/dashboard/profile/**',
      '/dashboard/changelog/**',
    ],
  },
  {
    id: 'project-shell',
    kind: 'chrome',
    routes: ['/dashboard/projects/[id]/**'],
    // Redirect-only routes: they forward at once, so no tour.
    except: ['/dashboard/projects/[id]/data/**', '/dashboard/projects/[id]/collections/**'],
  },
];
