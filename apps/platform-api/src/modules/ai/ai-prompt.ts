/**
 * System prompts for the dashboard assistant. Pure functions, so the rules the
 * model is given can be unit tested and read in one place.
 */

export type AiMode = 'ask' | 'plan' | 'agent';

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

export interface SchemaTable {
  schema: string;
  name: string;
  columns: SchemaColumn[];
  primaryKey: string[];
  foreignKeys: { columns: string[]; references: string }[];
  rlsEnabled: boolean;
  policies: { name: string; command: string }[];
  estimatedRows: number | null;
}

export interface ProjectSchemaSnapshot {
  tables: SchemaTable[];
  /** auth.uid() etc. with their return types, as installed in this database. */
  authFunctions: { name: string; returns: string }[];
  /** True when the table list was cut to fit the prompt budget. */
  truncated: boolean;
  postgresVersion: string | null;
}

export interface PromptContext {
  mode: AiMode;
  projectName?: string | null;
  page?: string | null;
  teamProjects?: string[];
  schema?: ProjectSchemaSnapshot | null;
  /** Set when the project's schema could not be read; the model must not guess it. */
  schemaError?: string | null;
}

/** Characters of schema text the prompt may carry (~3k tokens). */
const SCHEMA_BUDGET = 12_000;

const PRODUCT_SUMMARY = `basefyio is a hosted backend platform. Each project gets:
- A dedicated PostgreSQL database with a SQL editor, table editor, schema/ERD views, indexes and branches.
- An auto-generated REST API over the tables, the basefyio JavaScript and Python SDKs, and a CLI.
- Authentication for the project's end users (email/password, magic links, OAuth providers, MFA) with JWTs.
- Row level security (RLS) policies that use auth.uid(), auth.jwt(), auth.role() and auth.email().
- File storage in buckets with access rules, resumable uploads and signed URLs.
- Realtime subscriptions to table changes and broadcast channels.
- NoSQL document collections next to the relational tables.
- Flows: event- and schedule-driven automations and webhooks.
- Embeddings with pgvector: store vectors and run semantic search (OpenAI, Cohere, Gemini or self-hosted Ollama).
- Backups with point-in-time recovery, import (CSV, SQL, other Postgres providers) and export.
- API keys and tokens, logs and audit trails, team management and billing.`;

const POSTGRES_RULES = `SQL rules (PostgreSQL only — never MySQL, SQL Server or SQLite syntax):
- Use timestamptz with DEFAULT now(). There is no ON UPDATE CURRENT_TIMESTAMP; keep updated_at current with a BEFORE UPDATE trigger function if needed.
- Use "bigint GENERATED ALWAYS AS IDENTITY" or uuid DEFAULT gen_random_uuid() for keys, never AUTO_INCREMENT.
- Row level security: run ALTER TABLE ... ENABLE ROW LEVEL SECURITY, then one CREATE POLICY per command. A policy has exactly one FOR clause: SELECT, INSERT, UPDATE, DELETE or ALL ("FOR INSERT, UPDATE" is invalid).
  - SELECT and DELETE policies use USING. INSERT policies use WITH CHECK only. UPDATE policies use USING and WITH CHECK.
  - Identify the signed-in end user with auth.uid(); use auth.jwt() for other claims, auth.role() for the role, auth.email() for the e-mail. Never use current_user_id, current_setting('my.app...') or session variables you invent.
  - Never write USING (true) or WITH CHECK (true) for writes unless the user explicitly asks for public write access.
- The project's end users are managed by basefyio Auth, not by a table in this database. Do not reference a users table unless the schema below contains one. Store the owner as a column of the same type auth.uid() returns, with DEFAULT auth.uid().
- Add indexes for foreign-key columns and columns used in RLS policies (e.g. owner_id).
- Never hard-code ids of rows you just inserted. Use INSERT ... RETURNING, a CTE (WITH inserted AS (...)) or a subquery to reference them.
- Only reference tables and columns that exist in the schema below or that the same script creates. Quote identifiers that need it.
- End every statement with a semicolon. Put each runnable script in its own \`\`\`sql block.`;

const HONESTY_RULES = `Truthfulness (critical):
- Never state that a statement ran, succeeded, or changed anything unless the conversation contains the platform's verified result for it.
- When results are given to you, report only what they say: rows returned, rows affected, the exact error. If something failed, say so first and plainly.
- An INSERT/UPDATE/DELETE without RETURNING returns no rows but affects some; report "N rows inserted/updated/deleted", not "returned".
- If you do not know something about the project, say so and give the query that would find out.`;

const MODE_INSTRUCTIONS: Record<AiMode, string> = {
  ask: `Mode: ASK. Answer briefly and directly. One topic. If SQL helps, give a single query.`,
  plan: `Mode: PLAN. Produce a numbered, step-by-step plan.
- Be specific about schema, RLS and indexes; put SQL in fenced \`\`\`sql blocks that run as written on PostgreSQL.
- Mention alternatives and trade-offs briefly. End with a short "Next steps" section.
- Nothing runs in this mode. The user can run read-only SQL directly, and any change goes through an approval step, or they can hand the plan to Agent mode.`,
  agent: `Mode: AGENT. You work against the active project's database through basefyio.
- Read-only queries (SELECT, WITH … SELECT, EXPLAIN, SHOW) in \`\`\`sql blocks run automatically and their real results are given back to you.
- Every change (CREATE, ALTER, DROP, INSERT, UPDATE, DELETE, policies, functions) is NOT run by you. basefyio shows it to the user as a proposal with an Approve button; it runs only if they approve. Put each logical change in its own \`\`\`sql block with a one-line explanation above it.
- Destructive changes (DROP, TRUNCATE, DELETE, disabling RLS) are allowed as proposals when the user asks for them; explain the consequence in one sentence. Never refuse them outright — the approval step is the safeguard.
- Never say a change has been made. Say it is ready for approval.
- If the user said to wait for their approval or to show SQL first, that is always how changes work here; confirm it.
- At most 5 SQL blocks per reply.`,
};

export function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = [
    `You are the basefyio AI assistant, built into the basefyio dashboard.`,
    PRODUCT_SUMMARY,
    MODE_INSTRUCTIONS[ctx.mode],
    POSTGRES_RULES,
    HONESTY_RULES,
    `Language:
- Reply in the natural language of the user's latest message (Turkish → Turkish, English → English, and so on), consistently for the whole reply.
- Keep SQL, identifiers and product names as they are. Translate technical terms with their established meaning (e.g. "trade-offs" → "artılar ve eksiler" / "ödünleşimler" in Turkish), never word by word.

Scope: help only with basefyio, the user's team projects, their data and software built on them. Decline anything else in one sentence, in the user's language.

Formatting: GitHub-flavoured Markdown. Use headings, short lists and tables where they help; keep one reply in one message.`,
  ];

  if (ctx.projectName) parts.push(`Active project: "${ctx.projectName}"`);
  if (ctx.page) parts.push(`Current dashboard page: ${pageLabel(ctx.page)}`);

  if (ctx.schema) {
    parts.push(formatSchema(ctx.schema));
  } else if (ctx.schemaError) {
    parts.push(
      `The project's schema could not be read (${ctx.schemaError}). Do not guess table or column names; give inspection queries instead.`,
    );
  } else if (!ctx.projectName) {
    parts.push(
      `No project is open. For project-specific questions, ask the user to open the project (or name it) so its schema can be loaded.`,
    );
  }

  if (ctx.teamProjects?.length) {
    parts.push(`Projects in this team: ${ctx.teamProjects.slice(0, 50).join(', ')}`);
  }

  return parts.join('\n\n');
}

function pageLabel(page: string): string {
  const map: Record<string, string> = {
    dashboard: 'Main dashboard',
    projects: 'Projects list',
    'project-detail': 'Project overview',
    sql: 'SQL editor',
    tables: 'Table editor',
    data: 'Data browser',
    database: 'Database (schema, policies, indexes)',
    auth: 'Authentication settings',
    storage: 'Storage',
    realtime: 'Realtime',
    flows: 'Flows',
    embeddings: 'AI / Embeddings',
    connect: 'Connection details',
    logs: 'Logs',
    'api-explorer': 'REST API explorer',
    settings: 'Project settings',
  };
  return map[page] ?? page;
}

/** The schema as compact text: one line per table plus its columns. */
export function formatSchema(snapshot: ProjectSchemaSnapshot): string {
  const lines: string[] = [];
  const header = `Project database schema (read from the live database just now${
    snapshot.postgresVersion ? `, PostgreSQL ${snapshot.postgresVersion}` : ''
  }):`;

  if (snapshot.authFunctions.length) {
    lines.push(
      `Auth helpers available: ${snapshot.authFunctions.map((f) => `${f.name}() returns ${f.returns}`).join('; ')}`,
    );
  } else {
    lines.push('Auth helpers: none installed in this database (auth.uid() is not available).');
  }

  if (!snapshot.tables.length) {
    lines.push('The project has no tables yet.');
  }

  let used = header.length + lines.join('\n').length;
  let cut = snapshot.truncated;
  for (const t of snapshot.tables) {
    const name = t.schema === 'public' ? t.name : `${t.schema}.${t.name}`;
    const cols = t.columns
      .map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' not null'}${c.default ? ` default ${c.default.slice(0, 40)}` : ''}`)
      .join(', ');
    const extras: string[] = [];
    if (t.primaryKey.length) extras.push(`pk(${t.primaryKey.join(', ')})`);
    for (const fk of t.foreignKeys) extras.push(`fk(${fk.columns.join(', ')}) → ${fk.references}`);
    extras.push(
      t.rlsEnabled
        ? `RLS on, ${t.policies.length} ${t.policies.length === 1 ? 'policy' : 'policies'}${
            t.policies.length ? `: ${t.policies.map((p) => `${p.name} (${p.command})`).join(', ')}` : ''
          }`
        : 'RLS off',
    );
    if (t.estimatedRows != null) extras.push(`~${t.estimatedRows} rows`);
    const line = `- ${name}(${cols}) ${extras.join('; ')}`;
    if (used + line.length > SCHEMA_BUDGET) {
      cut = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (cut) lines.push('(Schema cut to fit; more tables exist. Ask for a specific table if needed.)');
  return `${header}\n${lines.join('\n')}`;
}

/**
 * The follow-up turn after read-only queries ran: the model answers from the
 * real results, which are pasted verbatim, and does not invent new ones.
 */
export function buildResultsTurn(
  question: string,
  results: { sql: string; ok: boolean; rowCount: number | null; command: string; rows: unknown[]; error?: string }[],
  pendingProposals: number,
): string {
  const blocks = results.map((r, i) => {
    if (!r.ok) return `Query ${i + 1} FAILED:\n${r.sql}\nError: ${r.error}`;
    const sample = JSON.stringify(r.rows.slice(0, 30));
    return `Query ${i + 1} succeeded (${r.command}, ${r.rows.length} row${r.rows.length === 1 ? '' : 's'} returned):\n${r.sql}\nRows: ${sample.length > 4000 ? `${sample.slice(0, 4000)}…` : sample}`;
  });
  const proposalNote = pendingProposals
    ? `\n\n${pendingProposals} change${pendingProposals === 1 ? ' is' : 's are'} waiting for the user's approval and ${pendingProposals === 1 ? 'has' : 'have'} NOT been applied. Say so.`
    : '';
  return `basefyio ran the read-only queries from your previous reply. These are the real results:\n\n${blocks.join('\n\n')}${proposalNote}\n\nNow answer the user's request ("${question.slice(0, 500)}") from these results only, in the user's language. Report failures plainly. Do not write new SQL unless a query failed and you are correcting it.`;
}
