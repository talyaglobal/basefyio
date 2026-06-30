/**
 * Couchbase SDK type stubs.
 *
 * These mirror the official couchbase Node.js SDK types so the provider
 * compiles without the native couchbase package installed (Windows dev, CI).
 * At runtime, the actual couchbase package is dynamically required.
 *
 * VENDOR-CONFINED: This file and everything in providers/nosql/ is the ONLY
 * place where vendor-specific types and naming appear.
 */

export interface ConnectOptions {
  username: string;
  password: string;
}

export interface Cluster {
  bucket(name: string): Bucket;
  query(statement: string, options?: QueryOptions): Promise<QueryResult>;
  ping(): Promise<PingResult>;
  close(): Promise<void>;
}

export interface Bucket {
  scope(name: string): Scope;
  defaultScope(): Scope;
  collections(): CollectionManager;
}

export interface Scope {
  collection(name: string): Collection;
  query(statement: string, options?: QueryOptions): Promise<QueryResult>;
}

export interface Collection {
  get(id: string, options?: GetOptions): Promise<GetResult>;
  insert(id: string, content: unknown, options?: InsertOptions): Promise<MutationResult>;
  replace(id: string, content: unknown, options?: ReplaceOptions): Promise<MutationResult>;
  upsert(id: string, content: unknown, options?: UpsertOptions): Promise<MutationResult>;
  remove(id: string, options?: RemoveOptions): Promise<MutationResult>;
}

export interface CollectionManager {
  createScope(name: string): Promise<void>;
  createCollection(collectionSpec: CollectionSpec): Promise<void>;
}

export interface CollectionSpec {
  name: string;
  scopeName: string;
}

export interface GetOptions {
  timeout?: number;
}

export interface GetResult {
  content: unknown;
  cas: CasValue;
}

export interface InsertOptions {
  timeout?: number;
}

export interface ReplaceOptions {
  cas?: CasValue;
  timeout?: number;
}

export interface UpsertOptions {
  timeout?: number;
}

export interface RemoveOptions {
  cas?: CasValue;
  timeout?: number;
}

export interface MutationResult {
  cas: CasValue;
}

export interface QueryOptions {
  parameters?: unknown[];
  readonly?: boolean;
  timeout?: number;
}

export interface QueryResult {
  rows: unknown[];
  meta?: { metrics?: { resultCount?: number } };
}

export interface PingResult {
  services: Record<string, unknown>;
}

/**
 * CAS (Compare-And-Swap) value. The SDK returns this as a special type;
 * we treat it as opaque and store the numeric representation.
 */
export type CasValue = unknown;

export function casToNumber(cas: CasValue): number {
  if (typeof cas === 'number') return cas;
  if (typeof cas === 'bigint') return Number(cas);
  if (typeof cas === 'string') return parseInt(cas, 10);
  // The SDK's Cas type has a toString() that returns a numeric string
  return Number(String(cas));
}
