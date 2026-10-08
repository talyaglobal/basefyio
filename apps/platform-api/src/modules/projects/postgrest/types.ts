/**
 * The shape of a PostgREST-style request once parsed.
 *
 * The REST data API speaks the query language supabase-js and postgrest-js
 * generate, so code written against that client runs unchanged here. Parsing
 * produces this tree; the builder turns it into parameterized SQL. Nothing from
 * the request reaches SQL as text except identifiers that the schema cache has
 * confirmed exist — every value travels as a bind parameter.
 */

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'match'
  | 'imatch'
  | 'in'
  | 'is'
  | 'isdistinct'
  | 'fts'
  | 'plfts'
  | 'phfts'
  | 'wfts'
  | 'cs'
  | 'cd'
  | 'ov'
  | 'sl'
  | 'sr'
  | 'nxl'
  | 'nxr'
  | 'adj';

export const FILTER_OPS: ReadonlySet<string> = new Set<FilterOp>([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'match', 'imatch',
  'in', 'is', 'isdistinct', 'fts', 'plfts', 'phfts', 'wfts',
  'cs', 'cd', 'ov', 'sl', 'sr', 'nxl', 'nxr', 'adj',
]);

/** One step down a JSON column: `->key` (json) or `->>key` (text). */
export interface JsonPathStep {
  op: '->' | '->>';
  key: string;
}

/** A column, optionally followed by a JSON path: `data->settings->>theme`. */
export interface FieldRef {
  column: string;
  jsonPath: JsonPathStep[];
}

export interface Condition {
  kind: 'cond';
  field: FieldRef;
  op: FilterOp;
  negate: boolean;
  /** Raw operand as sent; quoting already removed for scalar operands. */
  value: string;
  /** Text-search configuration for the fts family: `fts(english).cat`. */
  ftsConfig?: string;
}

export interface LogicTree {
  kind: 'logic';
  op: 'and' | 'or';
  negate: boolean;
  children: FilterNode[];
}

export type FilterNode = Condition | LogicTree;

export interface SelectColumn {
  kind: 'column';
  field: FieldRef;
  alias?: string;
  cast?: string;
}

export interface SelectStar {
  kind: 'star';
}

export interface SelectEmbed {
  kind: 'embed';
  /** Target relation name as written: `users` in `author:users(name)`. */
  relation: string;
  alias?: string;
  /** Disambiguation: a foreign-key constraint name, an FK column or a junction table. */
  hint?: string;
  /** `!inner` — only keep parent rows that have a matching child. */
  inner: boolean;
  select: SelectItem[];
}

export type SelectItem = SelectColumn | SelectStar | SelectEmbed;

export interface OrderTerm {
  field: FieldRef;
  dir: 'asc' | 'desc';
  /** Explicit `.nullsfirst` / `.nullslast`; otherwise the mode's default applies. */
  nulls?: 'first' | 'last';
}

/**
 * Filters, ordering and paging can be addressed to an embedded resource by
 * prefixing the key with its path: `comments.status=eq.open`,
 * `comments.order=created_at.desc`, `comments.limit=5`. The map key is that
 * path joined with dots; the empty string is the root.
 */
export interface ParsedQuery {
  select: SelectItem[];
  filters: Map<string, FilterNode[]>;
  order: Map<string, OrderTerm[]>;
  limit: Map<string, number>;
  offset: Map<string, number>;
}

/** Parse failures carry PostgREST's error code so clients can branch on it. */
export class PostgrestParseError extends Error {
  constructor(
    message: string,
    public readonly details?: string,
    public readonly code = 'PGRST100',
  ) {
    super(message);
    this.name = 'PostgrestParseError';
  }
}
