import type { TourDef } from '../types';

/** Area "project-data" copy. Ids must match routes/project-data.ts. */
export const DEFINITIONS: TourDef[] = [
  {
    id: 'project-overview',
    ready: 'project-overview-name',
    steps: [
      {
        anchor: 'project-overview-name',
        title: 'Project name',
        text: 'Select the name to rename this project.',
      },
      {
        anchor: 'project-overview-status',
        title: 'Status',
        text: 'Shows the project status; select it to change it.',
        align: 'end',
      },
      {
        anchor: 'project-overview-summary',
        title: 'Summary',
        text: 'A quick look at status, last import, linked services and a data snapshot.',
      },
      {
        anchor: 'project-overview-advisor',
        title: 'Advisor',
        text: 'Suggests next steps and points out things worth fixing in this project.',
      },
      {
        anchor: 'project-overview-database',
        title: 'Database',
        text: 'Your database name and address, each with its own copy button.',
      },
      {
        anchor: 'project-overview-anon-key',
        title: 'Anon Key',
        text: 'The public key your app sends with requests; copy it from here.',
      },
    ],
  },
  {
    id: 'project-tables',
    ready: 'project-tables-root',
    steps: [
      // Empty project: the first two. A SQL table open: find to grid-toolbar. A JSON collection
      // or an entity open: find to new plus its own toolbar. Missing ones drop out.
      {
        anchor: 'project-tables-empty',
        title: 'No data objects yet',
        text: 'Your tables, collections and entities will be listed here once you create one.',
      },
      {
        anchor: 'project-tables-create-first',
        title: 'Create New',
        text: 'Creates your first table, collection or entity.',
      },
      {
        anchor: 'project-tables-find',
        title: 'Search and filter',
        text: 'Search by name, or show only SQL tables, JSON collections or entities.',
        side: 'right',
      },
      {
        anchor: 'project-tables-list',
        title: 'Your data',
        text: 'Select an item to open it and see its rows or documents.',
        side: 'right',
      },
      {
        anchor: 'project-tables-open-tabs',
        title: 'Open tabs',
        text: 'Everything you have opened stays here so you can switch back quickly.',
        side: 'bottom',
      },
      {
        anchor: 'project-tables-import',
        title: 'Import Data',
        text: 'Loads rows from a CSV, Excel or JSON file into a table.',
        align: 'end',
      },
      {
        anchor: 'project-tables-new',
        title: 'New',
        text: 'Creates another table, collection or entity.',
        align: 'end',
      },
      {
        anchor: 'project-tables-grid-toolbar',
        title: 'Table tools',
        text: 'Filter rows, add a column or a row, or export the table.',
        align: 'end',
      },
      {
        anchor: 'project-tables-docs-toolbar',
        title: 'Document tools',
        text: 'Filter documents with a JSON query, or insert a new document.',
      },
      {
        // Twin of the step above: the entity panel is a different file, so it has its own anchor.
        anchor: 'project-tables-entity-toolbar',
        title: 'Document tools',
        text: 'Filter documents with a JSON query, or insert a new document.',
      },
    ],
  },
  {
    id: 'project-sql',
    ready: 'project-sql-card',
    steps: [
      // The query-mode switch exists on NoSQL projects only. SQL editor anchors and JS query
      // editor anchors live in different files; the visibility filter keeps whichever is on screen.
      {
        anchor: 'project-sql-mode',
        title: 'Query mode',
        text: 'Switch between JS queries on your collections and plain SQL.',
        align: 'end',
      },
      {
        anchor: 'project-sql-tabs',
        title: 'Query tabs',
        text: 'Each tab keeps its own query; double-click a tab name to rename it.',
      },
      {
        anchor: 'project-sql-new-tab',
        title: 'New tab',
        text: 'Opens another empty query tab.',
      },
      {
        anchor: 'project-sql-editor',
        title: 'Editor',
        text: 'Type your SQL here; press Ctrl+Enter to run it.',
      },
      {
        anchor: 'project-sql-run',
        title: 'Run',
        text: 'Runs the query; results appear below, ready to copy or download.',
        side: 'top',
        align: 'end',
      },
      {
        anchor: 'project-sql-js-tabs',
        title: 'Query tabs',
        text: 'Each tab keeps its own query; double-click a tab name to rename it.',
      },
      {
        anchor: 'project-sql-js-insert-name',
        title: 'Insert name',
        text: 'Adds a ready-made query for the entity or collection you pick.',
      },
      {
        anchor: 'project-sql-js-reference',
        title: 'Query reference',
        text: 'Shows a short cheat sheet of the query syntax.',
      },
      {
        anchor: 'project-sql-js-saved',
        title: 'Saved queries',
        text: 'Opens a query you saved earlier.',
        align: 'end',
      },
      {
        anchor: 'project-sql-js-save',
        title: 'Save',
        text: 'Saves the current query under a name so you can reuse it.',
        align: 'end',
      },
      {
        anchor: 'project-sql-js-editor',
        title: 'Editor',
        text: 'Type your query here; press Ctrl+Enter to run it.',
      },
      {
        anchor: 'project-sql-js-run',
        title: 'Run',
        text: 'Runs the query and shows the result below as a table or JSON.',
        side: 'top',
        align: 'end',
      },
    ],
  },
  {
    id: 'project-database',
    ready: 'project-database-tab-indexes',
    steps: [
      {
        anchor: 'project-database-tab-indexes',
        title: 'Indexes',
        text: 'Indexes make searches on large tables faster.',
        side: 'bottom',
        align: 'start',
      },
      {
        anchor: 'project-database-tab-triggers',
        title: 'Triggers',
        text: 'Triggers run a function automatically when rows are added, changed or deleted.',
        side: 'bottom',
      },
      {
        anchor: 'project-database-tab-functions',
        title: 'Functions',
        text: 'Functions hold database logic that your app can call like an API.',
        side: 'bottom',
      },
      {
        anchor: 'project-database-tab-extensions',
        title: 'Extensions',
        text: 'Extensions add optional database features you can switch on or off.',
        side: 'bottom',
      },
      {
        anchor: 'project-database-tab-policies',
        title: 'Policies',
        text: 'Policies decide which rows each user is allowed to read or change.',
        side: 'bottom',
      },
      {
        // The button reads New index, New trigger or New function by tab; absent on the other two.
        anchor: 'project-database-new',
        title: 'Create',
        text: 'Creates an index, trigger or function, depending on the tab you are on.',
        align: 'end',
      },
    ],
  },
  {
    id: 'project-api-explorer',
    ready: 'project-api-explorer-base-url',
    steps: [
      {
        anchor: 'project-api-explorer-table',
        title: 'Table',
        text: 'Choose the table whose endpoints you want to see.',
        align: 'start',
      },
      {
        anchor: 'project-api-explorer-base-url',
        title: 'Base URL',
        text: 'Every REST request for this project starts with this address.',
      },
      {
        anchor: 'project-api-explorer-security',
        title: 'Security note',
        text: 'Use the anon key in apps and keep the service key on your server.',
      },
      {
        // Only when a public table exists; anchored on the first (GET) card.
        anchor: 'project-api-explorer-endpoints',
        title: 'Endpoints',
        text: 'Open a card to see the request and copy it as curl or fetch.',
      },
      {
        anchor: 'project-api-explorer-filters',
        title: 'Filter Reference',
        text: 'Shows how to filter, sort and page results with query parameters.',
        side: 'top',
      },
    ],
  },
  {
    id: 'project-logs',
    ready: 'project-logs-timeline',
    steps: [
      {
        anchor: 'project-logs-filter',
        title: 'Filters',
        text: 'Search events, or narrow them by type and date range.',
        align: 'start',
      },
      {
        anchor: 'project-logs-export',
        title: 'Export CSV',
        text: 'Downloads the events that match your filters as a CSV file.',
      },
      {
        anchor: 'project-logs-timeline',
        title: 'Activity',
        text: 'A timeline of what happened in this project, newest first.',
      },
      {
        anchor: 'project-logs-pager',
        title: 'Pages',
        text: 'Move to older or newer events.',
        side: 'top',
      },
      {
        // Only on projects that were imported and still have an import log.
        anchor: 'project-logs-import-detail',
        title: 'Import detail',
        text: 'Shows what was copied when this project was imported, with any warnings.',
        side: 'top',
      },
    ],
  },
  {
    id: 'project-realtime',
    ready: 'project-realtime-list',
    steps: [
      {
        anchor: 'project-realtime-what-is-sent',
        title: 'What is sent',
        text: 'Only changes made through the REST API, SDK or table editor are sent, not raw SQL.',
      },
      {
        anchor: 'project-realtime-bulk',
        title: 'Select all / Clear all',
        text: 'Turns live updates on or off for everything in the list at once.',
        align: 'end',
      },
      {
        // Shows the first switch row, or the empty line on a project with no tables yet.
        anchor: 'project-realtime-list',
        title: 'Switches',
        text: 'Each table or collection gets a switch that turns its live updates on or off.',
      },
    ],
  },
  {
    id: 'project-embeddings',
    ready: 'project-embeddings-toggle',
    steps: [
      {
        anchor: 'project-embeddings-toggle',
        title: 'Vector Search',
        text: 'Turns on vector search so your app can find content by meaning.',
      },
      {
        anchor: 'project-embeddings-provider',
        title: 'Embedding provider',
        text: 'Choose which service and model turn your text into vectors.',
      },
      {
        anchor: 'project-embeddings-api-key',
        title: 'API key',
        text: "Optionally sets this project's own provider key; without it the platform key is used.",
      },
      {
        anchor: 'project-embeddings-data-flow',
        title: 'Where your data goes',
        text: 'Shows which provider receives your text; the vectors stay in your database.',
      },
      {
        // Only after vector search has been turned on.
        anchor: 'project-embeddings-api-reference',
        title: 'API Reference',
        text: 'Lists the endpoints and an example for storing and searching embeddings.',
        side: 'top',
      },
    ],
  },
];
