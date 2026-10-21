/**
 * Row-level security policies — client types, templates and the expressions
 * they expand to. The SQL that actually runs is always produced by the API
 * (dry run), so nothing here renders DDL; templates only fill the form.
 */

import type { ColumnInfo } from './types';

export type RlsPolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export type RlsPolicyRole = 'anon' | 'authenticated' | 'service_role' | 'public';

export const RLS_POLICY_COMMANDS: RlsPolicyCommand[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'];

export interface RlsPolicy {
  name: string;
  command: RlsPolicyCommand;
  permissive: boolean;
  roles: string[];
  using: string | null;
  withCheck: string | null;
}

export interface RlsPolicyTable {
  schema: string;
  name: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: RlsPolicy[];
}

/** Which auth.* helpers the project database carries. */
export interface RlsHelpers {
  uid: 'text' | 'uuid' | null;
  jwt: boolean;
  role: boolean;
  email: boolean;
  uidReadsLegacyClaimKey: boolean;
}

export interface RlsPoliciesOverview {
  tables: RlsPolicyTable[];
  helpers: RlsHelpers;
  roles: RlsPolicyRole[];
}

export interface RlsPolicyInput {
  table: string;
  name: string;
  command: RlsPolicyCommand;
  roles: RlsPolicyRole[];
  permissive?: boolean;
  using?: string;
  withCheck?: string;
}

export interface RlsMutationOptions {
  dryRun?: boolean;
  check?: boolean;
}

export interface RlsMutationResult {
  sql: string;
  applied: boolean;
  checked: boolean;
  message: string;
}

/** Commands whose policy takes a USING expression. */
export function commandTakesUsing(command: RlsPolicyCommand): boolean {
  return command !== 'INSERT';
}

/** Commands whose policy may take a WITH CHECK expression. */
export function commandTakesWithCheck(command: RlsPolicyCommand): boolean {
  return command === 'INSERT' || command === 'UPDATE' || command === 'ALL';
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * "This row belongs to the signed-in user", written to match the helper the
 * database actually has: a text auth.uid(), a uuid one, or none at all.
 */
export function ownerExpression(helpers: RlsHelpers, column: Pick<ColumnInfo, 'name' | 'type'>): string {
  const col = quoteIdent(column.name);
  const uuidColumn = /^uuid$/i.test(column.type);
  if (helpers.uid === 'uuid') return uuidColumn ? `auth.uid() = ${col}` : `auth.uid()::text = ${col}`;
  if (helpers.uid === 'text') return uuidColumn ? `auth.uid() = ${col}::text` : `auth.uid() = ${col}`;
  return `(current_setting('request.jwt.claims', true)::jsonb ->> 'sub') = ${col}::text`;
}

/** "This row's email column is the signed-in user's email". */
export function emailExpression(helpers: RlsHelpers, column: Pick<ColumnInfo, 'name'>): string {
  const col = quoteIdent(column.name);
  return helpers.jwt
    ? `(auth.jwt() ->> 'email') = ${col}`
    : `(current_setting('request.jwt.claims', true)::jsonb ->> 'email') = ${col}`;
}

export const OWNER_COLUMN_CANDIDATES = ['user_id', 'owner_id', 'created_by', 'author_id', 'uid'];
export const EMAIL_COLUMN_CANDIDATES = ['email', 'user_email', 'owner_email'];

export function pickColumn(columns: ColumnInfo[], candidates: string[]): ColumnInfo | undefined {
  for (const name of candidates) {
    const hit = columns.find((c) => c.name.toLowerCase() === name);
    if (hit) return hit;
  }
  return undefined;
}

type TemplateExpression = 'true' | 'owner' | 'email' | null;

export interface RlsPolicyTemplate {
  id: string;
  label: string;
  description: string;
  command: RlsPolicyCommand;
  roles: RlsPolicyRole[];
  permissive: boolean;
  using: TemplateExpression;
  withCheck: TemplateExpression;
  /** Which column the template compares against, if any. */
  column?: 'owner' | 'email';
}

export const RLS_POLICY_TEMPLATES: RlsPolicyTemplate[] = [
  {
    id: 'public_read',
    label: 'Everyone can read',
    description: 'Anyone with the public key or a signed-in session can read every row.',
    command: 'SELECT',
    roles: ['anon', 'authenticated'],
    permissive: true,
    using: 'true',
    withCheck: null,
  },
  {
    id: 'authenticated_read',
    label: 'Signed-in users can read',
    description: 'Signed-in users read every row; the public key reads nothing.',
    command: 'SELECT',
    roles: ['authenticated'],
    permissive: true,
    using: 'true',
    withCheck: null,
  },
  {
    id: 'own_select',
    label: 'Users read their own rows',
    description: 'A signed-in user sees only rows whose owner column matches their user id.',
    command: 'SELECT',
    roles: ['authenticated'],
    permissive: true,
    using: 'owner',
    withCheck: null,
    column: 'owner',
  },
  {
    id: 'own_insert',
    label: 'Users insert rows they own',
    description: 'A signed-in user may insert a row only with their own user id in the owner column.',
    command: 'INSERT',
    roles: ['authenticated'],
    permissive: true,
    using: null,
    withCheck: 'owner',
    column: 'owner',
  },
  {
    id: 'own_update',
    label: 'Users update their own rows',
    description: 'A signed-in user may change only their own rows, and cannot hand them to someone else.',
    command: 'UPDATE',
    roles: ['authenticated'],
    permissive: true,
    using: 'owner',
    withCheck: 'owner',
    column: 'owner',
  },
  {
    id: 'own_delete',
    label: 'Users delete their own rows',
    description: 'A signed-in user may delete only their own rows.',
    command: 'DELETE',
    roles: ['authenticated'],
    permissive: true,
    using: 'owner',
    withCheck: null,
    column: 'owner',
  },
  {
    id: 'own_all',
    label: 'Users fully control their own rows',
    description: 'Read, insert, update and delete, limited to rows the signed-in user owns.',
    command: 'ALL',
    roles: ['authenticated'],
    permissive: true,
    using: 'owner',
    withCheck: 'owner',
    column: 'owner',
  },
  {
    id: 'email_match',
    label: 'Rows matching the signed-in email',
    description: "A signed-in user sees rows whose email column equals the email in their token.",
    command: 'SELECT',
    roles: ['authenticated'],
    permissive: true,
    using: 'email',
    withCheck: null,
    column: 'email',
  },
];

export interface TemplateContext {
  helpers: RlsHelpers;
  column?: Pick<ColumnInfo, 'name' | 'type'>;
}

function resolveExpression(kind: TemplateExpression, ctx: TemplateContext): string {
  switch (kind) {
    case 'true':
      return 'true';
    case 'owner':
      return ownerExpression(ctx.helpers, ctx.column ?? { name: 'user_id', type: 'uuid' });
    case 'email':
      return emailExpression(ctx.helpers, ctx.column ?? { name: 'email' });
    default:
      return '';
  }
}

export interface TemplateFill {
  command: RlsPolicyCommand;
  roles: RlsPolicyRole[];
  permissive: boolean;
  using: string;
  withCheck: string;
}

/** The form values a template produces for the given database and column. */
export function applyTemplate(template: RlsPolicyTemplate, ctx: TemplateContext): TemplateFill {
  return {
    command: template.command,
    roles: [...template.roles],
    permissive: template.permissive,
    using: resolveExpression(template.using, ctx),
    withCheck: resolveExpression(template.withCheck, ctx),
  };
}
