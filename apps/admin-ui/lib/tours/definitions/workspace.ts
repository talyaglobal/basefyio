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
  {
    id: 'overview',
    ready: 'overview-new-project',
    steps: [
      {
        anchor: 'overview-sheet-to-app',
        title: 'Sheet to App',
        text: 'Turn an Excel or CSV file into database tables for a project.',
        align: 'end',
      },
      {
        anchor: 'overview-new-project',
        title: 'New Project',
        text: 'Create a new project with its own database.',
        align: 'end',
      },
      {
        anchor: 'overview-scope',
        title: 'Project scope',
        text: 'Choose whose projects and numbers this page shows, or view everything together.',
        align: 'start',
      },
      {
        anchor: 'overview-search',
        title: 'Search projects',
        text: 'Find a project by name across everything you belong to.',
      },
      {
        anchor: 'overview-stats',
        title: 'Key numbers',
        text: 'Each card shows a count; select one to open the related page.',
      },
      // Holds the "Create first project" empty state on a new account.
      {
        anchor: 'overview-recent',
        title: 'Recent Projects',
        text: 'Your most recently updated projects are listed here for quick access.',
        side: 'top',
      },
      {
        anchor: 'overview-quick-actions',
        title: 'Quick Actions',
        text: 'Shortcuts to create a project and open your project, member and account pages.',
        side: 'top',
      },
    ],
  },
  {
    id: 'blueprints',
    ready: 'blueprints-list',
    steps: [
      {
        anchor: 'blueprints-template',
        title: 'Starter template',
        text: 'Download a sample Excel file that shows how to lay out your data.',
        align: 'end',
      },
      // Disabled until a team is active, but always on screen.
      {
        anchor: 'blueprints-new',
        title: 'New from Excel',
        text: 'Pick an Excel or CSV file, then select Analyze to draft its tables.',
        align: 'end',
      },
      {
        anchor: 'blueprints-list',
        title: 'Your blueprints',
        text: 'Each file you analyze is saved here as a blueprint, a draft of its tables.',
        side: 'top',
      },
    ],
  },
  {
    id: 'blueprint-detail',
    ready: 'blueprint-detail-sync',
    steps: [
      {
        anchor: 'blueprint-detail-sync',
        title: 'Sync from Excel',
        text: 'Upload a newer version of the file to update this data model.',
        align: 'end',
      },
      // Shown in every status except while tables are being generated, and only outside edit mode.
      {
        anchor: 'blueprint-detail-edit',
        title: 'Edit',
        text: 'Rename tables and columns, or change their types and whether they are required.',
        align: 'end',
      },
      {
        anchor: 'blueprint-detail-table',
        title: 'Data model',
        text: 'The tables and columns basefyio worked out from your file.',
      },
      // The next four exist only in some statuses; the filter keeps the ones on screen.
      {
        anchor: 'blueprint-detail-approve',
        title: 'Approve',
        text: 'Confirm the data model so its tables can be created.',
        side: 'top',
        align: 'start',
      },
      {
        anchor: 'blueprint-detail-target',
        title: 'Target project',
        text: "Choose the project whose database will receive the tables.",
        side: 'top',
        align: 'start',
      },
      {
        anchor: 'blueprint-detail-generate',
        title: 'Generate tables',
        text: "Create these tables in the chosen project's database.",
        side: 'top',
      },
      {
        anchor: 'blueprint-detail-plan',
        title: 'Plan changes',
        text: 'List the differences between this model and the tables already created.',
        side: 'left',
      },
    ],
  },
  {
    id: 'account',
    ready: 'account-save',
    steps: [
      {
        anchor: 'account-photo',
        title: 'Profile photo',
        text: 'Choose a photo to represent your account.',
      },
      {
        anchor: 'account-name',
        title: 'Name',
        text: 'Set the name shown for you across the dashboard.',
      },
      {
        anchor: 'account-save',
        title: 'Save changes',
        text: 'Saves your photo, name and, where it can be changed, your email.',
        align: 'end',
      },
      {
        anchor: 'account-signin-emails',
        title: 'Sign-in emails',
        text: 'Choose when basefyio emails you about a sign-in to your account.',
      },
      {
        anchor: 'account-browser-alerts',
        title: 'Browser notifications',
        text: 'Turn on security alerts in this browser and send yourself a test.',
      },
      {
        anchor: 'account-save-notifications',
        title: 'Save notification preferences',
        text: 'Saves the email and browser notification choices above.',
        align: 'end',
      },
      // Shown only while the guided_tours flag is on for this user.
      {
        anchor: 'account-tours',
        title: 'Guided tours',
        text: 'Turn automatic tours on or off, or show every tour again.',
      },
      // Email and password accounts only; Google and GitHub accounts see an info card instead.
      {
        anchor: 'account-password',
        title: 'Change password',
        text: 'Set a new password for signing in to basefyio.',
        side: 'top',
      },
    ],
  },
  {
    id: 'api-tokens',
    ready: 'api-tokens-table',
    steps: [
      {
        anchor: 'api-tokens-connect-agent',
        title: 'Connect an AI agent',
        text: 'Create a read-only token and get the setup steps for an MCP client.',
        align: 'end',
      },
      {
        anchor: 'api-tokens-create',
        title: 'Create Token',
        text: 'Create a token and choose exactly which permissions it has.',
        align: 'end',
      },
      {
        anchor: 'api-tokens-status-filter',
        title: 'Status filter',
        text: 'Show all tokens, or only the active or revoked ones.',
        align: 'end',
      },
      // On a new account the table shows one "No API tokens yet" row.
      {
        anchor: 'api-tokens-table',
        title: 'Your tokens',
        text: 'Each token with its permissions, last use, expiry and status.',
        side: 'top',
      },
      // First active row only: Edit and Roll secret are disabled on revoked rows.
      {
        anchor: 'api-tokens-row-actions',
        title: 'Token actions',
        text: 'Edit a token, replace its secret with a new one, or revoke it.',
        side: 'left',
      },
    ],
  },
  {
    id: 'api-token-form',
    ready: 'api-token-form-all',
    steps: [
      {
        anchor: 'api-token-form-name',
        title: 'Token name',
        text: 'Give the token a name that tells you where it is used.',
      },
      // New-token page only, and only when the server offers the read-only MCP scopes.
      {
        anchor: 'api-token-form-preset',
        title: 'MCP (read-only)',
        text: 'Fill in the read-only permissions an AI agent needs in one step.',
      },
      {
        anchor: 'api-token-form-all',
        title: 'All permissions',
        text: 'Turn every permission on or off at once.',
      },
      {
        anchor: 'api-token-form-group',
        title: 'Permission groups',
        text: 'Switch on only the permissions this token needs, one by one or per group.',
      },
      {
        anchor: 'api-token-form-expiry',
        title: 'Expiry (optional)',
        text: 'Pick the date the token stops working, or leave it empty.',
        side: 'top',
      },
      {
        anchor: 'api-token-form-save',
        title: 'Save token',
        text: 'Saves the token with the name, permissions and expiry above.',
        side: 'top',
        align: 'end',
      },
    ],
  },
  {
    id: 'team',
    ready: 'team-members',
    steps: [
      // Only when someone has invited you.
      {
        anchor: 'team-my-invites',
        title: 'Pending Invites',
        text: 'Accept or decline invitations that other people sent you.',
      },
      // Owner, or a role that was granted the permission.
      {
        anchor: 'team-invite',
        title: 'Invite',
        text: 'Invite someone by email to work with you here.',
        align: 'end',
      },
      {
        anchor: 'team-name',
        title: 'Name',
        text: 'Rename it; everyone who belongs to it sees the new name.',
      },
      {
        anchor: 'team-members',
        title: 'Members',
        text: 'Lists everyone with access, their role and any invitations still waiting.',
      },
      // First member the owner can change.
      {
        anchor: 'team-member-role',
        title: 'Role',
        text: 'Switch this person between Admin and Member.',
        side: 'left',
      },
      // Owner only.
      {
        anchor: 'team-permissions',
        title: 'Role Permissions',
        text: 'Decide what Admins and Members may do, then save your changes.',
        side: 'top',
      },
      {
        anchor: 'team-integrations',
        title: 'Integrations',
        text: 'Connect GitHub and Vercel once so every project here can use them.',
        side: 'top',
      },
    ],
  },
  {
    id: 'org-overview',
    ready: 'org-overview-stats',
    steps: [
      {
        anchor: 'org-overview-header',
        title: 'Organization',
        text: 'The organization you are viewing, with its type, plan and shareable address.',
      },
      {
        anchor: 'org-overview-tabs',
        title: 'Sections',
        text: "Move between this organization's projects, members, billing and settings.",
      },
      {
        anchor: 'org-overview-stats',
        title: 'At a glance',
        text: 'Each card shows a count and opens the matching section.',
      },
      {
        anchor: 'org-overview-open-projects',
        title: 'Open projects',
        text: 'Go to the project list to open or create projects.',
        side: 'top',
        align: 'start',
      },
      {
        anchor: 'org-overview-invite',
        title: 'Invite a member',
        text: 'Opens the Members section, where you can send an invitation.',
        side: 'top',
        align: 'start',
      },
    ],
  },
  {
    id: 'org-projects',
    ready: 'org-projects-list',
    steps: [
      {
        anchor: 'org-projects-list',
        title: 'Projects',
        text: 'Every project in this organization is listed here with its status.',
      },
      // Only when the organization has projects.
      {
        anchor: 'org-projects-open',
        title: 'Open a project',
        text: 'Select a project name to open that project.',
        side: 'bottom',
        align: 'start',
      },
      // Only when the organization has no projects yet.
      {
        anchor: 'org-projects-create',
        title: 'Create the first one',
        text: "Go to the project list to create this organization's first project.",
      },
    ],
  },
  {
    id: 'org-settings',
    ready: 'org-settings-profile',
    steps: [
      {
        anchor: 'org-settings-profile',
        title: 'Profile',
        text: 'The name, type and description that members and invited people see.',
      },
      // Owner or admin only.
      {
        anchor: 'org-settings-save',
        title: 'Save changes',
        text: 'Saves your edits to the profile above.',
        align: 'end',
      },
      {
        anchor: 'org-settings-address',
        title: 'Address',
        text: 'Copy the permanent link of this organization to share with members.',
      },
    ],
  },
  {
    id: 'org-new',
    ready: 'org-new-name',
    steps: [
      {
        anchor: 'org-new-steps',
        title: 'Steps',
        text: 'Creating an organization takes three short steps: name, type and plan.',
      },
      {
        anchor: 'org-new-name',
        title: 'Name',
        text: 'Give the organization a name; you can change it later.',
      },
      {
        anchor: 'org-new-next',
        title: 'Next',
        text: 'Continue to choose a type and a plan before anything is created.',
        align: 'end',
      },
    ],
  },
  {
    id: 'feedbacks',
    ready: 'feedbacks-list',
    steps: [
      {
        anchor: 'feedbacks-status-filter',
        title: 'Status filter',
        text: 'Show only the feedback with the status you pick, or all of it.',
      },
      {
        anchor: 'feedbacks-search',
        title: 'Search',
        text: 'Type to narrow the list to matching feedback.',
      },
      {
        anchor: 'feedbacks-list',
        title: 'Your feedback',
        text: 'Issues and ideas you send from the Feedback button are tracked here.',
        side: 'top',
      },
      // The next three exist only on the first listed item.
      {
        anchor: 'feedbacks-dev-action',
        title: 'Developer action',
        text: 'Shows what the basefyio team is doing, and opens the full history.',
      },
      {
        anchor: 'feedbacks-comment',
        title: 'Comment',
        text: 'Add a comment with optional images or video for the basefyio team.',
      },
      {
        anchor: 'feedbacks-mark-done',
        title: 'Mark done',
        text: 'Mark the item as done once it is solved for you.',
        side: 'left',
      },
    ],
  },
  {
    id: 'billing',
    ready: 'billing-plan',
    steps: [
      {
        anchor: 'billing-plan',
        title: 'Current Plan',
        text: 'Shows the plan that is active right now.',
      },
      {
        anchor: 'billing-add-card',
        title: 'Add card',
        text: 'Save a payment card to use for paid plans and invoices.',
        side: 'left',
      },
      {
        anchor: 'billing-details',
        title: 'Billing Details',
        text: 'Keep your company, tax and address details for invoices here.',
        side: 'top',
      },
      // Only once usage and plan data have loaded.
      {
        anchor: 'billing-usage',
        title: 'Usage',
        text: 'See how much of your plan you have used so far.',
        side: 'top',
      },
      // Only when the cost report has loaded.
      {
        anchor: 'billing-project-costs',
        title: 'Project costs',
        text: 'A running estimate of what each project adds up to this billing period.',
        side: 'top',
      },
      // Hidden on legacy and enterprise plans.
      {
        anchor: 'billing-plans',
        title: 'Plans',
        text: 'Compare the available plans and switch to another one.',
        side: 'top',
      },
      {
        anchor: 'billing-invoices',
        title: 'Invoices',
        text: 'Each charge appears here as an invoice, marked paid or unpaid.',
        side: 'top',
      },
    ],
  },
];
