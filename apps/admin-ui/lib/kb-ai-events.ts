/** CustomEvent name for programmatic AI assistant messages (opens panel + sends). */
export const KB_AI_SEND_EVENT = 'kb-ai-send';

export type KbAiSendDetail = {
  message: string;
  mode?: 'ask' | 'plan' | 'agent';
};

export function dispatchKbAiMessage(detail: KbAiSendDetail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(KB_AI_SEND_EVENT, { detail }));
}

/** User ran assistant SQL via "Run"; DB error — send back to AI for fix. */
export function buildSqlRunErrorPrompt(sql: string, errorMessage: string): string {
  const err = (errorMessage || 'Unknown error').trim();
  return (
    `[KolayBase — SQL from assistant]\n` +
    `I used the **Run** button on a SQL block you suggested. The database returned an error.\n\n` +
    `--- SQL ---\n${sql.trim()}\n\n` +
    `--- Error ---\n${err}\n\n` +
    `Explain why this failed (missing roles like service_role, RLS, grants, extensions, schema, or KolayBase vs Supabase differences) and give corrected SQL or setup steps I should take.`
  );
}

export function buildSupabaseImportIssuePrompt(params: {
  projectName: string;
  projectId: string;
  kind: 'warning' | 'failed_table' | 'auth_skipped';
  detail: string;
  lineIndex?: number;
}): string {
  const header = `[KolayBase — Supabase import]\nProject: "${params.projectName}" (id: ${params.projectId})\n`;
  switch (params.kind) {
    case 'warning':
      return `${header}This warning appeared during import${params.lineIndex != null ? ` (line ${params.lineIndex})` : ''}:\n\n"""\n${params.detail}\n"""\n\nExplain the most likely root causes and concrete fixes (PostgreSQL, PostgREST, RLS, service role, direct DB password, storage, Keycloak auth sync, etc.). Be specific and actionable for this stack.`;
    case 'failed_table':
      return `${header}Table "${params.detail}" failed to import.\n\nExplain likely causes and step-by-step remediation (RLS, permissions, connection string, database password for direct copy, table size, etc.).`;
    case 'auth_skipped':
      return `${header}${params.detail}\n\nExplain why KolayBase/Keycloak might skip auth users during import and what to check or change (email, duplicates, Keycloak config).`;
  }
}
