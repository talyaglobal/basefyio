/**
 * Starter tables for a new relational project (#240): what the "Find the right
 * database" advisor suggests, created for real when the user keeps the box ticked.
 *
 * The SQL is fixed here, never built from input: the request only names a key.
 * Every table has a uuid id, created_at, and owner_id defaulting to the signed-in
 * user, so row-level security policies can be written against it later. Grants
 * follow the project's data access settings, because the tables are created as
 * the project owner.
 */
export const STARTER_KEYS = [
  'CRM', 'Inventory', 'ERP', 'Marketplace', 'SaaS', 'CMS', 'AI', 'Analytics', 'Files', 'General',
] as const;
export type StarterKey = (typeof STARTER_KEYS)[number];

type Column = string;
interface TableDef {
  name: string;
  columns: Column[];
}

const base = (extra: Column[]): Column[] => [
  'id uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  ...extra,
  // auth.uid() is text here (the user's id as a string).
  'owner_id text DEFAULT auth.uid()',
  'created_at timestamptz NOT NULL DEFAULT now()',
];
const t = (name: string, extra: Column[]): TableDef => ({ name, columns: base(extra) });
const ref = (col: string, table: string, onDelete = 'SET NULL') => `${col} uuid REFERENCES public.${table}(id) ON DELETE ${onDelete}`;

const STARTERS: Record<StarterKey, TableDef[]> = {
  CRM: [
    t('companies', ['name text NOT NULL', 'website text', 'industry text']),
    t('customers', ['name text NOT NULL', 'email text', 'phone text', ref('company_id', 'companies')]),
    t('deals', ['title text NOT NULL', 'amount numeric(14,2)', "stage text NOT NULL DEFAULT 'new'", ref('customer_id', 'customers'), 'close_date date']),
    t('activities', ['kind text NOT NULL', 'notes text', ref('customer_id', 'customers', 'CASCADE'), ref('deal_id', 'deals'), 'happened_at timestamptz DEFAULT now()']),
    t('tasks', ['title text NOT NULL', 'due_date date', 'done boolean NOT NULL DEFAULT false', ref('deal_id', 'deals')]),
  ],
  Inventory: [
    t('categories', ['name text NOT NULL']),
    t('suppliers', ['name text NOT NULL', 'email text', 'phone text']),
    t('warehouses', ['name text NOT NULL', 'location text']),
    t('products', ['sku text UNIQUE', 'name text NOT NULL', 'price numeric(14,2)', ref('category_id', 'categories'), ref('supplier_id', 'suppliers')]),
    t('stock_movements', [ref('product_id', 'products', 'CASCADE'), ref('warehouse_id', 'warehouses'), 'quantity integer NOT NULL', 'reason text']),
  ],
  ERP: [
    t('accounts', ['name text NOT NULL', 'kind text', 'tax_number text']),
    t('employees', ['full_name text NOT NULL', 'email text', 'department text', 'hired_on date']),
    t('products', ['name text NOT NULL', 'unit_price numeric(14,2)']),
    t('orders', [ref('account_id', 'accounts'), "status text NOT NULL DEFAULT 'draft'", 'total numeric(14,2)']),
    t('invoices', [ref('order_id', 'orders'), ref('account_id', 'accounts'), 'number text UNIQUE', 'amount numeric(14,2)', 'due_date date', 'paid boolean NOT NULL DEFAULT false']),
  ],
  Marketplace: [
    t('profiles', ['display_name text NOT NULL', 'avatar_url text']),
    t('listings', [ref('seller_id', 'profiles'), 'title text NOT NULL', 'description text', 'price numeric(14,2)', "status text NOT NULL DEFAULT 'active'"]),
    t('orders', [ref('listing_id', 'listings'), ref('buyer_id', 'profiles'), 'quantity integer NOT NULL DEFAULT 1', "status text NOT NULL DEFAULT 'pending'"]),
    t('payments', [ref('order_id', 'orders', 'CASCADE'), 'amount numeric(14,2) NOT NULL', 'provider_ref text', "status text NOT NULL DEFAULT 'pending'"]),
    t('reviews', [ref('listing_id', 'listings', 'CASCADE'), ref('author_id', 'profiles'), 'rating smallint CHECK (rating BETWEEN 1 AND 5)', 'body text']),
  ],
  SaaS: [
    t('plans', ['name text NOT NULL', 'price_monthly numeric(10,2)', "limits jsonb NOT NULL DEFAULT '{}'"]),
    t('accounts', ['name text NOT NULL', ref('plan_id', 'plans')]),
    t('members', [ref('account_id', 'accounts', 'CASCADE'), 'user_id uuid', "role text NOT NULL DEFAULT 'member'"]),
    t('subscriptions', [ref('account_id', 'accounts', 'CASCADE'), ref('plan_id', 'plans'), "status text NOT NULL DEFAULT 'active'", 'renews_at timestamptz']),
    t('usage_events', [ref('account_id', 'accounts', 'CASCADE'), 'event text NOT NULL', 'quantity numeric NOT NULL DEFAULT 1']),
  ],
  CMS: [
    t('authors', ['name text NOT NULL', 'bio text']),
    t('categories', ['name text NOT NULL', 'slug text UNIQUE']),
    t('pages', ['title text NOT NULL', 'slug text UNIQUE', 'body text', 'published boolean NOT NULL DEFAULT false']),
    t('posts', ['title text NOT NULL', 'slug text UNIQUE', 'body text', ref('author_id', 'authors'), ref('category_id', 'categories'), 'published_at timestamptz']),
    t('media', ['file_path text NOT NULL', 'alt_text text', 'mime_type text']),
  ],
  AI: [
    t('documents', ['title text NOT NULL', 'source text', "metadata jsonb NOT NULL DEFAULT '{}'"]),
    t('chunks', [ref('document_id', 'documents', 'CASCADE'), 'content text NOT NULL', 'position integer']),
    t('conversations', ['title text']),
    t('messages', [ref('conversation_id', 'conversations', 'CASCADE'), "role text NOT NULL DEFAULT 'user'", 'content text NOT NULL']),
  ],
  Analytics: [
    t('sources', ['name text NOT NULL', 'kind text']),
    t('sessions', [ref('source_id', 'sources'), 'started_at timestamptz DEFAULT now()', 'ended_at timestamptz']),
    t('events', [ref('source_id', 'sources'), ref('session_id', 'sessions'), 'name text NOT NULL', "properties jsonb NOT NULL DEFAULT '{}'", 'occurred_at timestamptz NOT NULL DEFAULT now()']),
    t('metrics', ['name text NOT NULL', 'value numeric NOT NULL', 'measured_at timestamptz NOT NULL DEFAULT now()']),
  ],
  Files: [
    t('folders', ['name text NOT NULL', 'parent_id uuid']),
    t('files', [ref('folder_id', 'folders'), 'name text NOT NULL', 'storage_path text NOT NULL', 'size_bytes bigint', 'mime_type text']),
    t('tags', ['name text NOT NULL UNIQUE']),
    t('shares', [ref('file_id', 'files', 'CASCADE'), 'shared_with uuid', "permission text NOT NULL DEFAULT 'read'"]),
  ],
  General: [
    t('categories', ['name text NOT NULL']),
    t('items', ['name text NOT NULL', 'description text', ref('category_id', 'categories')]),
  ],
};

export function isStarterKey(value: unknown): value is StarterKey {
  return typeof value === 'string' && (STARTER_KEYS as readonly string[]).includes(value);
}

export function starterTables(key: StarterKey): string[] {
  return STARTERS[key].map((d) => d.name);
}

/** The statements for one starter, in dependency order, each table created only if missing. */
export function starterSql(key: StarterKey): string[] {
  return STARTERS[key].map((d) => `CREATE TABLE IF NOT EXISTS public.${d.name} (\n  ${d.columns.join(',\n  ')}\n)`);
}
