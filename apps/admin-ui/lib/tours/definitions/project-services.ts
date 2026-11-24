import type { TourDef } from '../types';

/** Area "project-services" copy. Ids must match routes/project-services.ts. */
export const DEFINITIONS: TourDef[] = [
  {
    id: 'project-auth',
    ready: 'project-auth-tabs',
    steps: [
      {
        anchor: 'project-auth-add-user',
        title: 'Add User',
        text: 'Create a user by hand with a name, email and password.',
        align: 'end',
      },
      {
        anchor: 'project-auth-stats',
        title: 'Overview',
        text: 'Shows the user count and the sign-up and sign-in addresses for your app.',
      },
      {
        anchor: 'project-auth-tabs',
        title: 'Sections',
        text: 'Switch between users, sessions, security rules, sign-in settings, providers and email.',
      },
      {
        anchor: 'project-auth-tab-settings',
        title: 'Settings',
        text: 'Decide who can sign up and whether email must be verified first.',
      },
      {
        anchor: 'project-auth-tab-providers',
        title: 'Providers',
        text: 'Turn on social sign-in such as Google or GitHub.',
      },
      {
        anchor: 'project-auth-tab-email',
        title: 'Email',
        text: 'Choose how sign-in emails are sent and edit their wording.',
      },
      {
        anchor: 'project-auth-search',
        title: 'Search users',
        text: 'Find users by email, name or username.',
      },
      {
        anchor: 'project-auth-user-list',
        title: 'Users',
        text: 'Select a user to see details, reset a password or sign them out.',
      },
    ],
  },
  {
    id: 'project-storage',
    // Present on the bucket list (once loaded) and on an opened bucket.
    ready: 'project-storage-root',
    steps: [
      {
        anchor: 'project-storage-new-bucket',
        title: 'New bucket',
        text: 'Create a bucket, a separate space for files, public or private.',
        align: 'end',
      },
      {
        anchor: 'project-storage-bucket-list',
        title: 'Buckets',
        text: 'Lists your buckets with access, file count and size; select one to open it.',
      },
      {
        anchor: 'project-storage-back',
        title: 'Back to buckets',
        text: 'Return to the list of all buckets.',
        align: 'start',
      },
      {
        anchor: 'project-storage-tabs',
        title: 'Files and Settings',
        text: 'Files shows the bucket contents; Settings controls who can read them.',
      },
      {
        anchor: 'project-storage-new-folder',
        title: 'New folder',
        text: 'Create a folder inside the one you are viewing.',
        align: 'end',
      },
      {
        anchor: 'project-storage-upload',
        title: 'Upload',
        text: 'Upload one or more files into the folder you are viewing.',
        align: 'end',
      },
      {
        anchor: 'project-storage-path',
        title: 'Path',
        text: 'Shows where you are in the bucket; select a level to jump back.',
      },
      {
        anchor: 'project-storage-files',
        title: 'Files',
        text: 'Lists folders and files; tick several to move or delete them together.',
      },
    ],
  },
  {
    id: 'project-connect',
    ready: 'project-connect-tabs',
    steps: [
      {
        anchor: 'project-connect-tabs',
        title: 'Views',
        text: 'Raw Editor gives ready-made variables; basefyio Details lists every address and key.',
      },
      {
        anchor: 'project-connect-framework',
        title: 'Framework and format',
        text: 'Pick your framework and ENV or JSON so the variable names fit your app.',
      },
      {
        // The label reads Copy ENV or Copy JSON, depending on the chosen format.
        anchor: 'project-connect-copy',
        title: 'Copy variables',
        text: 'Copies all variables with their real values; secrets stay hidden on screen.',
        align: 'end',
      },
      {
        anchor: 'project-connect-ai-prompt',
        title: 'AI prompt for quick connect',
        text: 'A ready prompt that tells your AI assistant how to connect to this project.',
      },
      // The three steps below appear when the tour starts with the basefyio Details tab open.
      {
        anchor: 'project-connect-database',
        title: 'External Database Access',
        text: 'Connection details for opening the database in any database client.',
      },
      {
        anchor: 'project-connect-rest',
        title: 'REST API',
        text: 'The web address your app calls to read and write data.',
      },
      {
        anchor: 'project-connect-api-keys',
        title: 'API Keys',
        text: 'Copy your keys here; managers can also replace them or add secret keys.',
      },
    ],
  },
  {
    id: 'project-integrations',
    ready: 'project-integrations-github',
    steps: [
      {
        anchor: 'project-integrations-status',
        title: 'Connections',
        text: 'Shows which GitHub and Vercel accounts your team has connected.',
      },
      {
        anchor: 'project-integrations-manage',
        title: 'Manage',
        text: 'Opens your team page, where these accounts are connected or removed.',
        align: 'end',
      },
      {
        anchor: 'project-integrations-github',
        title: 'GitHub',
        text: 'Link a repository to this project and see its latest commits.',
      },
      {
        anchor: 'project-integrations-vercel',
        title: 'Vercel',
        text: "Link a Vercel project and send it this project's environment variables.",
      },
    ],
  },
  {
    id: 'project-flows',
    ready: 'project-flows-list',
    steps: [
      {
        anchor: 'project-flows-new',
        title: 'New flow',
        text: 'Create an automation: a trigger and the actions it runs in order.',
        align: 'end',
      },
      {
        anchor: 'project-flows-list',
        title: 'Your flows',
        text: 'Every flow you create is listed here.',
      },
      {
        anchor: 'project-flows-runs',
        title: 'Recent runs',
        text: "Opens the flow's latest runs and their results.",
        align: 'start',
      },
      {
        anchor: 'project-flows-enabled',
        title: 'Enabled',
        text: 'Switches the flow on or off without deleting it.',
        align: 'end',
      },
      {
        anchor: 'project-flows-run',
        title: 'Run',
        text: 'Starts the flow right now.',
        align: 'end',
      },
    ],
  },
  {
    id: 'project-branches',
    ready: 'project-branches-intro',
    steps: [
      {
        anchor: 'project-branches-intro',
        title: 'Preview branches',
        text: 'A branch is a separate copy of this project for testing changes safely.',
      },
      {
        anchor: 'project-branches-new',
        title: 'New branch',
        text: "Create a branch from this project's structure, with or without its data.",
        align: 'end',
      },
      {
        // Shown instead of the button and list on NoSQL projects and on branches.
        anchor: 'project-branches-unavailable',
        title: 'Not available here',
        text: 'Explains why new branches cannot be created from this project.',
      },
      {
        anchor: 'project-branches-list',
        title: 'Your branches',
        text: 'Shows each branch and whether its copy is ready; open one to work in it.',
      },
    ],
  },
  {
    id: 'project-backup',
    ready: 'project-backup-export-options',
    steps: [
      {
        anchor: 'project-backup-pitr',
        title: 'Point-in-time recovery',
        text: 'Rewind the database to a moment you choose within the recovery window.',
      },
      {
        anchor: 'project-backup-health',
        title: 'Backup health',
        text: 'Shows where backups are kept and whether the newest one was tested.',
      },
      {
        anchor: 'project-backup-verify',
        title: 'Verify now',
        text: 'Tests the newest nightly backup by restoring it into a temporary database.',
        align: 'end',
      },
      {
        anchor: 'project-backup-export-options',
        title: 'Export options',
        text: 'Choose which parts of the project go into the download.',
      },
      {
        anchor: 'project-backup-start-export',
        title: 'Start Export',
        text: 'Builds a ZIP of the chosen parts for you to download.',
      },
      {
        anchor: 'project-backup-cloud',
        title: 'Cloud backups',
        text: 'Lists stored backups; restore one as a new project or over this one.',
      },
    ],
  },
  {
    id: 'project-settings',
    ready: 'project-settings-general',
    steps: [
      {
        anchor: 'project-settings-general',
        title: 'General',
        text: "Change the project's name and description.",
      },
      {
        anchor: 'project-settings-organization',
        title: 'Organization',
        text: 'Put the project in a folder and add tags to find it faster.',
      },
      {
        anchor: 'project-settings-save',
        title: 'Save changes',
        text: 'Saves the name, description, folder and tags above.',
        align: 'start',
      },
      {
        anchor: 'project-settings-data-access',
        title: 'Data access',
        text: 'Sets how API keys reach tables created from now on; each change saves at once.',
      },
      {
        anchor: 'project-settings-rows',
        title: 'Data editor page size',
        text: 'Sets how many rows the Data editor loads in one page.',
      },
      {
        anchor: 'project-settings-team',
        title: 'Team',
        text: 'Moves this project, with its data, auth and storage, to another team you own.',
      },
      {
        anchor: 'project-settings-danger',
        title: 'Danger zone',
        text: 'Pause the project or move it to the trash.',
      },
    ],
  },
];
