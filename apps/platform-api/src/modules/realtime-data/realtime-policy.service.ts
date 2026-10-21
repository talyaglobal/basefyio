import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  DataChangeEvent,
  PolicySubscriber,
  RealtimeKind,
  SubscriberRole,
} from './realtime-data.types';

export type RlsFilterMode = 'all' | 'jwt' | 'off';

export interface TableMeta {
  /** Row-level security is enabled (or forced) on the table. */
  rls: boolean;
  /** Primary key columns, in index order; empty when the table has none. */
  pk: string[];
}

/** Claims that differ between two tokens of the same user and never carry policy meaning. */
const VOLATILE_CLAIMS = new Set(['exp', 'iat', 'nbf', 'jti', 'auth_time', 'session_state', 'sid', 'at_hash']);

/** Roles a policy check may SET LOCAL to. The service role is never checked. */
const CHECKABLE_ROLES: ReadonlySet<SubscriberRole> = new Set<SubscriberRole>(['anon', 'authenticated']);

const DEFAULT_META_TTL_MS = 60_000;
const POOL_IDLE_EVICT_MS = 2 * 60_000;
const BATCH_WINDOW_MS = 15;
const BATCH_MAX = 50;
const WARN_EVERY_MS = 10 * 60_000;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * Subscribers whose policy verdict is necessarily the same share one group:
 * same role, same claims once the per-token noise (expiry, token id, session)
 * is removed. Two tabs of one user therefore cost one check, not two.
 */
export function policyGroupOf(role: SubscriberRole, claims?: Record<string, unknown>): string {
  if (role === 'service_role') return 'service';
  const stable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(claims ?? {})) {
    if (!VOLATILE_CLAIMS.has(k)) stable[k] = v;
  }
  return createHash('sha256').update(`${role}|${canonicalJson(stable)}`).digest('hex').slice(0, 32);
}

interface PendingCheck {
  pkValues: unknown[];
  resolve: (visible: boolean) => void;
}

interface Batch {
  projectId: string;
  schema: string;
  table: string;
  role: SubscriberRole;
  claims: Record<string, unknown> | undefined;
  pk: string[];
  pending: PendingCheck[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Applies a project's row-level security to realtime delivery.
 *
 * A change event carries the whole row; whether a given subscriber may see it
 * is a question only Postgres can answer, so for a table with RLS enabled the
 * changed row is re-selected under the subscriber's role with the subscriber's
 * claims — the same `SET LOCAL ROLE` + `request.jwt.claims` the REST data
 * plane uses — and delivered only where the select returns it. Tables without
 * RLS are left exactly as before: every candidate receives the event.
 *
 * The filter never adds a recipient; it only narrows. On any failure to decide
 * it withholds the event from the subscribers it could not decide for.
 */
@Injectable()
export class RealtimePolicyService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimePolicyService.name);
  private readonly mode: RlsFilterMode;
  private readonly metaTtlMs: number;

  /** `${projectId}|${schema}.${table}` → catalogue facts, with fetch time. */
  private readonly metaCache = new Map<string, { meta: TableMeta; at: number }>();
  private readonly poolCache = new Map<string, { pool: Pool; lastUsed: number }>();
  private readonly batches = new Map<string, Batch>();
  private readonly warnedAt = new Map<string, number>();
  private readonly evictTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const raw = (config.get<string>('REALTIME_RLS_FILTER') ?? 'jwt').toLowerCase();
    this.mode = raw === 'all' || raw === 'off' ? raw : 'jwt';
    const ttl = Number(config.get<string>('REALTIME_RLS_META_TTL_MS'));
    this.metaTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_META_TTL_MS;
    this.evictTimer = setInterval(() => this.evictIdlePools(), 60_000);
    (this.evictTimer as any).unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.evictTimer);
    for (const [id, entry] of this.poolCache) {
      entry.pool.end().catch(() => undefined);
      this.poolCache.delete(id);
    }
  }

  getMode(): RlsFilterMode {
    return this.mode;
  }

  /**
   * Decide who among `candidates` may receive `event`.
   *
   * Returns the subscribers to deliver to and the event to deliver (a DELETE on
   * an RLS table is reduced to its primary key, since a deleted row cannot be
   * re-selected).
   */
  async filterByPolicy<S extends PolicySubscriber>(
    projectId: string,
    event: DataChangeEvent,
    candidates: S[],
  ): Promise<{ deliverTo: S[]; event: DataChangeEvent }> {
    if (this.mode === 'off' || candidates.length === 0) return { deliverTo: candidates, event };

    const passThrough: S[] = [];
    const checked: S[] = [];
    for (const sub of candidates) {
      if (sub.role === 'service_role') passThrough.push(sub);
      else if (sub.role === 'anon' && this.mode === 'jwt') passThrough.push(sub);
      else checked.push(sub);
    }
    if (checked.length === 0) return { deliverTo: candidates, event };

    const schema = schemaFor(event.kind);
    const meta = await this.tableMeta(projectId, schema, event.entity);
    if (!meta) {
      // Could not learn whether the table has RLS: withhold from those we
      // cannot decide for, never from those that need no decision.
      this.warnOnce(`${projectId}|meta|${schema}.${event.entity}`,
        `could not read catalogue facts for ${schema}.${event.entity} of project ${projectId}; events withheld from policy-checked subscribers`);
      return { deliverTo: passThrough, event };
    }
    if (!meta.rls) return { deliverTo: candidates, event };

    if (event.type === 'DELETE') {
      return { deliverTo: candidates, event: { ...event, old: pickPk(event.old, meta.pk) } };
    }

    if (meta.pk.length === 0) {
      this.warnOnce(`${projectId}|nopk|${schema}.${event.entity}`,
        `${schema}.${event.entity} of project ${projectId} has row-level security but no primary key; realtime events are withheld from non-service subscribers`);
      return { deliverTo: passThrough, event };
    }

    const row = event.new;
    if (!row) return { deliverTo: passThrough, event };
    const pkValues = meta.pk.map((c) => row[c]);
    if (pkValues.some((v) => v === undefined)) return { deliverTo: passThrough, event };

    const groups = new Map<string, S[]>();
    for (const sub of checked) {
      const list = groups.get(sub.policyGroup);
      if (list) list.push(sub);
      else groups.set(sub.policyGroup, [sub]);
    }

    const deliverTo = [...passThrough];
    await Promise.all(
      [...groups.values()].map(async (members) => {
        const rep = members[0];
        const visible = await this.isVisible(projectId, schema, event.entity, meta.pk, pkValues, rep.role, rep.jwtClaims);
        if (visible) deliverTo.push(...members);
      }),
    );
    return { deliverTo, event };
  }

  // ── Visibility checks (batched per group) ────────────────

  private isVisible(
    projectId: string,
    schema: string,
    table: string,
    pk: string[],
    pkValues: unknown[],
    role: SubscriberRole,
    claims: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    if (!CHECKABLE_ROLES.has(role)) return Promise.resolve(false);
    const key = `${projectId}|${schema}.${table}|${policyGroupOf(role, claims)}`;
    return new Promise<boolean>((resolve) => {
      let batch = this.batches.get(key);
      if (!batch) {
        batch = { projectId, schema, table, role, claims, pk, pending: [], timer: null };
        this.batches.set(key, batch);
      }
      batch.pending.push({ pkValues, resolve });
      if (batch.pending.length >= BATCH_MAX) {
        this.flush(key);
      } else if (!batch.timer) {
        batch.timer = setTimeout(() => this.flush(key), BATCH_WINDOW_MS);
      }
    });
  }

  private flush(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;
    this.batches.delete(key);
    if (batch.timer) clearTimeout(batch.timer);
    void this.runBatch(batch);
  }

  private async runBatch(batch: Batch): Promise<void> {
    const { pending } = batch;
    let visible: Set<string>;
    try {
      visible = await this.selectVisible(batch);
    } catch (err: any) {
      this.warnOnce(`${batch.projectId}|check|${batch.schema}.${batch.table}|${batch.role}`,
        `policy check failed for ${batch.schema}.${batch.table} of project ${batch.projectId} as ${batch.role}: ${err?.message}` +
          (err?.code === '42501'
            ? ` — the project may predate the RLS bootstrap; run POST /projects/${batch.projectId}/ensure-rls-bootstrap`
            : ''));
      for (const p of pending) p.resolve(false);
      return;
    }
    for (const p of pending) p.resolve(visible.has(pkKey(p.pkValues)));
  }

  /** One transaction under the group's role: which of the pending rows are selectable. */
  private async selectVisible(batch: Batch): Promise<Set<string>> {
    const { schema, table, pk, pending, role, claims } = batch;
    for (const ident of [schema, table, ...pk]) {
      if (!IDENT_RE.test(ident)) throw new Error(`invalid identifier "${ident}"`);
    }
    const params: unknown[] = [];
    const tuples = pending.map((p) => {
      const placeholders = p.pkValues.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return pk.length === 1 ? placeholders[0] : `(${placeholders.join(', ')})`;
    });
    const cols = pk.map((c) => `"${c}"`).join(', ');
    const selectCols = pk.map((c, i) => `"${c}"::text AS c${i}`).join(', ');
    const lhs = pk.length === 1 ? cols : `(${cols})`;
    const sql = `SELECT ${selectCols} FROM "${schema}"."${table}" WHERE ${lhs} IN (${tuples.join(', ')})`;

    const pool = await this.getPool(batch.projectId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE "${role}"`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? {})]);
      await client.query(`SELECT set_config('request.jwt.role', $1, true)`, [role]);
      const res = await client.query(sql, params);
      const out = new Set<string>();
      for (const r of res.rows as Record<string, unknown>[]) {
        out.add(pkKey(pk.map((_, i) => r[`c${i}`])));
      }
      return out;
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* noop */
      }
      client.release();
    }
  }

  // ── Catalogue facts ──────────────────────────────────────

  /** RLS flag and primary key of a table, cached; `null` when it could not be read. */
  async tableMeta(projectId: string, schema: string, table: string): Promise<TableMeta | null> {
    const key = `${projectId}|${schema}.${table}`;
    const cached = this.metaCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < this.metaTtlMs) return cached.meta;
    try {
      const pool = await this.getPool(projectId);
      const res = await pool.query(
        `SELECT (c.relrowsecurity OR c.relforcerowsecurity) AS rls,
                COALESCE((SELECT array_agg(a.attname::text ORDER BY k.ord)
                            FROM pg_index i
                            JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
                            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                           WHERE i.indrelid = c.oid AND i.indisprimary), '{}'::text[]) AS pk
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
      );
      const row = res.rows[0] as { rls: boolean; pk: string[] } | undefined;
      // A table that no longer exists cannot have policies; deliver as before.
      const meta: TableMeta = row ? { rls: !!row.rls, pk: row.pk ?? [] } : { rls: false, pk: [] };
      this.metaCache.set(key, { meta, at: now });
      return meta;
    } catch (err: any) {
      this.logger.debug(`tableMeta failed for ${key}: ${err?.message}`);
      // A stale answer beats no answer: the flag rarely changes.
      return cached?.meta ?? null;
    }
  }

  /** Forget cached catalogue facts (tests, or a future policy-editor hook). */
  invalidate(projectId?: string): void {
    if (!projectId) {
      this.metaCache.clear();
      return;
    }
    for (const key of this.metaCache.keys()) {
      if (key.startsWith(`${projectId}|`)) this.metaCache.delete(key);
    }
  }

  // ── Pools ────────────────────────────────────────────────

  private async getPool(projectId: string): Promise<Pool> {
    const cached = this.poolCache.get(projectId);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached.pool;
    }
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: { dbHost: true, dbPort: true, dbUser: true, dbPassword: true, dbName: true },
    });
    if (!project) throw new Error('project not found or inactive');
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      // Small on purpose: a policy check is one indexed lookup, and a project
      // pays for these connections only while it has checked subscribers.
      max: 2,
      statement_timeout: 2_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => this.logger.debug(`policy pool error for ${projectId}: ${err.message}`));
    this.poolCache.set(projectId, { pool, lastUsed: Date.now() });
    return pool;
  }

  private evictIdlePools(): void {
    const now = Date.now();
    for (const [id, entry] of this.poolCache) {
      if (now - entry.lastUsed > POOL_IDLE_EVICT_MS) {
        this.poolCache.delete(id);
        entry.pool.end().catch((err) => this.logger.debug(`pool end failed for ${id}: ${err.message}`));
      }
    }
  }

  private warnOnce(key: string, message: string): void {
    const last = this.warnedAt.get(key) ?? 0;
    const now = Date.now();
    if (now - last < WARN_EVERY_MS) return;
    this.warnedAt.set(key, now);
    this.logger.warn(message);
  }
}

function schemaFor(kind: RealtimeKind): string {
  return kind === 'collection' ? 'nosql' : 'public';
}

function pickPk(row: Record<string, unknown> | null, pk: string[]): Record<string, unknown> | null {
  if (!row || pk.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const c of pk) if (c in row) out[c] = row[c];
  return out;
}

function pkKey(values: unknown[]): string {
  return JSON.stringify(values.map((v) => (v === null || v === undefined ? null : String(v))));
}
