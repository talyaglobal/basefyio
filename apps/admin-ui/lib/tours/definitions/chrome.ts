import type { TourDef } from '../types';

/** Area "chrome" copy. Ids must match routes/chrome.ts. */
export const DEFINITIONS: TourDef[] = [
  {
    id: 'shell',
    ready: 'shell-user-menu',
    steps: [
      // Feedback (xl and up) and Menu (below xl) are never visible together.
      {
        anchor: 'shell-feedback',
        title: 'Feedback',
        text: 'Report a problem or share an idea with the basefyio team.',
      },
      {
        anchor: 'shell-menu',
        title: 'Menu',
        text: 'Reach every page, the docs and feedback from this menu on smaller screens.',
        align: 'end',
      },
      {
        anchor: 'shell-team-switcher',
        title: 'Team or organization',
        text: 'Change which team or organization you are working in.',
        align: 'end',
      },
      {
        anchor: 'shell-projects-switcher',
        title: 'Projects',
        text: 'Jump straight to any active project, with search by name.',
        align: 'end',
      },
      {
        anchor: 'shell-tour-button',
        title: 'Tour',
        text: 'Replay the guided tour for the page you are on at any time.',
        align: 'end',
      },
      {
        anchor: 'shell-notifications',
        title: 'Notifications',
        text: 'Finished imports, AI answers and replies to your feedback show up here.',
        align: 'end',
      },
      {
        anchor: 'shell-user-menu',
        title: 'Your account',
        text: 'Open your account settings or sign out.',
        align: 'end',
      },
      {
        anchor: 'shell-sidebar',
        title: 'Navigation',
        text: 'Move between the overview, projects, members, billing, account, API tokens and feedback pages.',
        side: 'right',
      },
      {
        anchor: 'shell-ai',
        title: 'basefyio AI',
        text: 'Ask the built-in assistant about your projects and data.',
        side: 'left',
      },
    ],
  },
  {
    id: 'project-shell',
    ready: 'project-shell-nav',
    steps: [
      {
        anchor: 'project-shell-nav',
        title: 'Project menu',
        text: 'Every tool for this project, from data to settings, opens from this menu.',
        side: 'right',
      },
      {
        anchor: 'project-shell-nav-tables',
        title: 'Data',
        text: 'Browse and edit your tables, collections and entities in one place.',
        side: 'right',
      },
      {
        // The /sql link reads "SQL Editor" or "Query" by database type; this copy fits both.
        anchor: 'project-shell-nav-sql',
        title: 'Queries',
        text: "Write and run queries against this project's database.",
        side: 'right',
      },
      {
        anchor: 'project-shell-nav-storage',
        title: 'Storage',
        text: 'Upload files and organize them in buckets.',
        side: 'right',
      },
      {
        anchor: 'project-shell-nav-auth',
        title: 'Auth',
        text: 'Manage the people who sign in to your app and how they sign in.',
        side: 'right',
      },
      {
        anchor: 'project-shell-nav-connect',
        title: 'Connection',
        text: 'Get the addresses and keys your app needs to connect to this project.',
        side: 'right',
      },
      {
        anchor: 'project-shell-api-keys',
        title: 'API Keys',
        text: 'Shows your public anon key; the copy button puts it on your clipboard.',
        side: 'right',
      },
      {
        anchor: 'project-shell-nav-logs',
        title: 'Project logs',
        text: 'See a timeline of everything that happened in this project.',
        side: 'right',
      },
    ],
  },
];
