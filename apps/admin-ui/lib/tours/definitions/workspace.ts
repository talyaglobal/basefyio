import type { TourDef } from '../types';

/** Area "workspace" copy. Ids must match routes/workspace.ts. */
export const DEFINITIONS: TourDef[] = [
  {
    id: 'projects',
    ready: 'projects-main',
    steps: [
      // Below 1024 px the folders panel hides behind this button; at 1024 px and up the sidebar shows.
      {
        anchor: 'projects-folders-toggle',
        title: 'Folders',
        text: 'Open the panel with your folders, tags, Trash and Deactivated list.',
      },
      {
        anchor: 'projects-search',
        title: 'Search projects',
        text: 'Type to narrow the list to matching projects.',
      },
      {
        anchor: 'projects-view-toggle',
        title: 'Grid or list',
        text: 'Switch between project cards and a compact list.',
        align: 'end',
      },
      {
        anchor: 'projects-sheet-to-app',
        title: 'Sheet to App',
        text: 'Turn an Excel or CSV file into database tables for a project.',
        align: 'end',
      },
      {
        anchor: 'projects-new',
        title: 'New Project',
        text: 'Create a new project with its own database.',
        align: 'end',
      },
      {
        anchor: 'projects-sidebar',
        title: 'Folders and tags',
        text: 'Organize projects into folders and tags, or open Trash to restore deleted ones.',
        side: 'right',
      },
      // The first card or row and its menu exist only when a project is listed; the empty state otherwise.
      {
        anchor: 'projects-card',
        title: 'Project',
        text: 'Open a project to work with its data, API and settings.',
      },
      {
        anchor: 'projects-card-actions',
        title: 'More actions',
        text: 'Rename, move, tag, deactivate or delete this project.',
      },
      {
        anchor: 'projects-empty',
        title: 'No projects yet',
        text: 'Your projects will appear here once you create the first one.',
        side: 'top',
        align: 'center',
      },
    ],
  },
];
