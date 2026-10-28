/**
 * The Supabase Storage facade driven by the REAL `@supabase/storage-js`
 * client (the one supabase-js ships) over HTTP against the Nest app, with the
 * object store replaced by an in-memory fake and the project database by a
 * stubbed RLS runner. Every call a Supabase app makes — upload (multipart and
 * raw), download, exists, list, remove, signed URLs, signed uploads, move,
 * copy, info, buckets — goes through the same wire protocol the hosted
 * product speaks.
 */
import {
  CanActivate,
  ExecutionContext,
  ConflictException,
  ForbiddenException,
  INestApplication,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageApiError, StorageClient } from '@supabase/storage-js';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import * as jwt from 'jsonwebtoken';

jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../pgbouncer/pgbouncer.service', () => ({ PgBouncerService: class {} }));

import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { API_KEY_SCOPE_KEY } from '../../common/decorators/api-key-scope.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectRlsRunner } from '../project-db/project-rls-runner';
import { ImageTransformService } from '../storage/image-transform.service';
import { StorageAccessService } from '../storage/storage-access.service';
import { StorageCatalogService } from '../storage/storage-catalog.service';
import { StorageService } from '../storage/storage.service';
import { ProjectWakeService } from './project-wake.service';
import { StorageFacadeService } from './storage-facade.service';
import { StorageSigningService } from './storage-signing.service';
import { StorageV1Controller } from './storage-v1.controller';
import { StorageV1PublicController } from './storage-v1-public.controller';
import { isJsonBody, rewriteSupabasePaths } from '../../common/middleware/supabase-paths.middleware';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT = {
  id: 'p1',
  slug: 'proj',
  storagePrefix: null as string | null,
  teamId: 't1',
  status: 'ACTIVE',
  keycloakRealm: 'realm-p1',
  anonKey: 'anon-key',
  serviceKey: 'service-key',
  storageAuthz: 'presets',
};

interface StoredObject {
  buf: Buffer;
  contentType: string;
  meta: Record<string, string>;
  etag: string;
  lastModified: Date;
}

interface CatalogRow {
  id: string;
  bucket_id: string;
  name: string;
  owner_id: string | null;
  metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown> | null;
  version: string | null;
  created_at: Date;
  updated_at: Date;
  last_accessed_at: Date;
}

/** The object store, in memory, exposing what StorageService exposes to the facade. */
class FakeStore {
  buckets = new Map<string, { public: boolean; createdAt: string; objects: Map<string, StoredObject> }>();
  /** Rows the RLS stub judges — written here the way StorageCatalogService would. */
  catalog = new Map<string, CatalogRow>();
  physical = (name: string) => `bf-proj-${name}`;
  logical = (physical: string) => physical.replace(/^bf-proj-/, '');

  private bucketOf(physical: string) {
    const b = this.buckets.get(this.logical(physical));
    if (!b) throw new NotFoundException(`Bucket "${this.logical(physical)}" not found`);
    return b;
  }

  private stat(o: StoredObject) {
    const metaData: Record<string, unknown> = { 'content-type': o.contentType };
    for (const [k, v] of Object.entries(o.meta)) metaData[k.toLowerCase().replace(/^x-amz-meta-/, '')] = v;
    return { size: o.buf.length, etag: o.etag, lastModified: o.lastModified, metaData };
  }

  private record(bucket: string, key: string, o: StoredObject) {
    const now = new Date();
    const prev = this.catalog.get(`${bucket}/${key}`);
    this.catalog.set(`${bucket}/${key}`, {
      id: prev?.id ?? `cat-${createHash('md5').update(`${bucket}/${key}`).digest('hex').slice(0, 8)}`,
      bucket_id: bucket,
      name: key,
      owner_id: o.meta['x-amz-meta-owner'] ?? prev?.owner_id ?? null,
      metadata: {
        eTag: `"${o.etag}"`,
        size: o.buf.length,
        mimetype: o.contentType,
        cacheControl: o.meta['Cache-Control'] ?? 'no-cache',
        lastModified: o.lastModified.toISOString(),
        contentLength: o.buf.length,
        httpStatusCode: 200,
      },
      user_metadata: o.meta['x-amz-meta-user-metadata'] ? JSON.parse(o.meta['x-amz-meta-user-metadata']) : null,
      version: o.etag,
      created_at: prev?.created_at ?? now,
      updated_at: now,
      last_accessed_at: now,
    });
  }

  async resolveBucket(_p: string, _u: string | undefined, name: string) {
    if (!this.buckets.has(name)) throw new NotFoundException(`Bucket "${name}" not found`);
    return { project: PROJECT, minioBucket: this.physical(name) };
  }
  async statObjectIn(physical: string, key: string) {
    const o = this.bucketOf(physical).objects.get(key);
    return o ? this.stat(o) : null;
  }
  async uploadObjectStream(
    _p: string,
    _u: string | undefined,
    bucket: string,
    key: string,
    body: Readable,
    _size: number,
    contentType: string,
    meta: Record<string, string> = {},
  ) {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const buf = Buffer.concat(chunks);
    const o: StoredObject = {
      buf,
      contentType,
      meta,
      etag: createHash('md5').update(buf).digest('hex'),
      lastModified: new Date('2026-10-28T12:00:00Z'),
    };
    this.bucketOf(this.physical(bucket)).objects.set(key, o);
    this.record(bucket, key, o);
    return { name: key, size: buf.length, contentType, lastModified: o.lastModified, etag: o.etag, id: this.catalog.get(`${bucket}/${key}`)!.id };
  }
  async getObjectIn(physical: string, key: string, range?: { offset: number; length?: number }) {
    const o = this.bucketOf(physical).objects.get(key);
    if (!o) throw new NotFoundException(`Object "${key}" not found`);
    const slice = range ? o.buf.subarray(range.offset, range.length === undefined ? undefined : range.offset + range.length) : o.buf;
    return { stream: Readable.from([slice]), stat: this.stat(o) };
  }
  async listObjectsIn(physical: string, prefix = '', recursive = false) {
    const b = this.bucketOf(physical);
    const out: Array<{ name: string; prefix?: string; size: number; lastModified: Date; etag?: string }> = [];
    const seen = new Set<string>();
    for (const [key, o] of b.objects) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (!recursive && slash >= 0) {
        const folder = prefix + rest.slice(0, slash + 1);
        if (!seen.has(folder)) {
          seen.add(folder);
          out.push({ name: '', prefix: folder, size: 0, lastModified: new Date() });
        }
        continue;
      }
      out.push({ name: key, size: o.buf.length, lastModified: o.lastModified, etag: o.etag });
    }
    return out;
  }
  async removeObjectsIn(physical: string, keys: readonly string[]) {
    const b = this.bucketOf(physical);
    for (const k of keys) {
      b.objects.delete(k);
      this.catalog.delete(`${this.logical(physical)}/${k}`);
    }
  }
  async deleteObjects(_p: string, _u: string | undefined, bucket: string, keys: string[]) {
    await this.removeObjectsIn(this.physical(bucket), keys);
    return { message: `Deleted ${keys.length} object(s)` };
  }
  async copyObjectIn(srcP: string, srcK: string, destP: string, destK: string) {
    const o = this.bucketOf(srcP).objects.get(srcK);
    if (!o) throw new Error('NoSuchKey');
    this.bucketOf(destP).objects.set(destK, { ...o, lastModified: new Date() });
  }
  async moveObject(_p: string, _u: string | undefined, bucket: string, src: string, dest: string, destBucket = bucket) {
    await this.copyObjectIn(this.physical(bucket), src, this.physical(destBucket), dest);
    const o = this.bucketOf(this.physical(destBucket)).objects.get(dest)!;
    await this.removeObjectsIn(this.physical(bucket), [src]);
    this.record(destBucket, dest, o);
    return { name: dest };
  }
  async copyObject(_p: string, _u: string | undefined, bucket: string, src: string, dest: string, destBucket = bucket, meta: Record<string, string> = {}) {
    await this.copyObjectIn(this.physical(bucket), src, this.physical(destBucket), dest);
    const o = this.bucketOf(this.physical(destBucket)).objects.get(dest)!;
    o.meta = { ...o.meta, ...meta };
    this.record(destBucket, dest, o);
    return { name: dest, size: o.buf.length, etag: o.etag, id: this.catalog.get(`${destBucket}/${dest}`)!.id };
  }
  async bucketIsPublic(physical: string) {
    return this.bucketOf(physical).public;
  }
  async listBucketNames() {
    return [...this.buckets.entries()].map(([name, b]) => ({ name, physical: this.physical(name), createdAt: b.createdAt }));
  }
  async createBucket(_p: string, _u: string | undefined, name: string, isPublic = false) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,60}[A-Za-z0-9]$/.test(name)) {
      throw new Error('Bucket name must be 3-63 chars, alphanumeric and hyphens');
    }
    if (this.buckets.has(name)) throw new ConflictException(`Bucket "${name}" already exists`);
    this.buckets.set(name, { public: isPublic, createdAt: '2026-10-28T00:00:00.000Z', objects: new Map() });
    return { id: this.physical(name), name, public: isPublic };
  }
  async toggleBucketPublic(_p: string, _u: string | undefined, name: string, isPublic: boolean) {
    this.bucketOf(this.physical(name)).public = isPublic;
    return { public: isPublic };
  }
  async deleteBucket(_p: string, _u: string | undefined, name: string) {
    this.bucketOf(this.physical(name));
    this.buckets.delete(name);
    return { message: 'deleted' };
  }
}

/**
 * Stands in for the project database: anon may read, never write; a signed-in
 * user owns what they upload and sees everything; the service role sees all.
 */
function rlsRunnerStub(store: FakeStore) {
  const calls: Array<{ role: string; sql: string; dryRun: boolean }> = [];
  const client = (ctx: { role: string; jwtClaims?: Record<string, unknown> }) => ({
    query: async (text: string, values: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      const sub = ctx.jwtClaims?.sub as string | undefined;
      const canSee = (row: CatalogRow) => ctx.role === 'service_role' || ctx.role === 'authenticated' || row.bucket_id === 'public-docs';
      const canWrite = (row: CatalogRow) => ctx.role === 'service_role' || (ctx.role === 'authenticated' && row.owner_id === sub);
      if (sql.startsWith('INSERT INTO storage.objects')) {
        if (ctx.role === 'anon') throw Object.assign(new Error('denied'), { code: '42501' });
        const existing = store.catalog.get(`${values[0]}/${values[1]}`);
        if (existing && !sql.includes('ON CONFLICT')) throw Object.assign(new Error('dup'), { code: '23505' });
        if (existing && !canWrite(existing)) throw Object.assign(new Error('denied'), { code: '42501' });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, bucket_id, name')) {
        const row = store.catalog.get(`${values[0]}/${values[1]}`);
        return { rows: row && canSee(row) ? [row] : [] };
      }
      if (sql.startsWith('WITH scoped AS')) {
        const [bucket, prefix, , search, limit, offset] = values as [string, string, number, string, number, number];
        const entries = new Map<string, any>();
        for (const row of store.catalog.values()) {
          if (row.bucket_id !== bucket || !row.name.startsWith(prefix) || !canSee(row)) continue;
          const rest = row.name.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash >= 0) {
            const folder = rest.slice(0, slash);
            if (!entries.has(folder)) entries.set(folder, { name: folder, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null });
          } else {
            entries.set(rest, { name: rest, id: row.id, updated_at: row.updated_at, created_at: row.created_at, last_accessed_at: row.last_accessed_at, metadata: row.metadata });
          }
        }
        let rows = [...entries.values()].filter((e) => !search || e.name.toLowerCase().includes(search.toLowerCase()));
        rows.sort((a, b) => a.name.localeCompare(b.name));
        if (/ORDER BY name DESC/.test(sql)) rows.reverse();
        rows = rows.slice(offset, offset + limit);
        return { rows };
      }
      if (sql.startsWith('DELETE FROM storage.objects')) {
        const [bucket, names] = values as [string, string[]];
        const rows: any[] = [];
        for (const name of names) {
          const row = store.catalog.get(`${bucket}/${name}`);
          if (!row || !canWrite(row)) continue;
          store.catalog.delete(`${bucket}/${name}`);
          rows.push({ name: row.name, id: row.id, updated_at: row.updated_at, created_at: row.created_at, last_accessed_at: row.last_accessed_at, metadata: row.metadata });
        }
        return { rows };
      }
      if (sql.startsWith('UPDATE storage.objects SET bucket_id')) {
        const [bucket, src, destBucket, dest] = values as string[];
        const row = store.catalog.get(`${bucket}/${src}`);
        if (!row || !canWrite(row)) return { rows: [] };
        store.catalog.delete(`${bucket}/${src}`);
        store.catalog.set(`${destBucket}/${dest}`, { ...row, bucket_id: destBucket, name: dest });
        return { rows: [{ id: row.id }] };
      }
      if (sql.includes('FROM storage.buckets')) {
        const rows = [...store.buckets.entries()]
          .filter(([name]) => !sql.includes('WHERE id = $1') || name === values[0])
          .map(([name, b]) => ({
            id: name,
            name,
            owner: null,
            owner_id: null,
            public: b.public,
            file_size_limit: null,
            allowed_mime_types: null,
            created_at: new Date(b.createdAt),
            updated_at: new Date(b.createdAt),
          }));
        return { rows };
      }
      throw new Error(`rls stub: unexpected SQL ${sql.slice(0, 60)}`);
    },
  });
  return {
    calls,
    runRlsTransaction: jest.fn(async (_p: string, ctx: any, fn: (c: any) => Promise<unknown>, opts: { dryRun?: boolean } = {}) => {
      const c = client(ctx);
      const wrapped = {
        query: async (text: string, values?: unknown[]) => {
          calls.push({ role: ctx.role, sql: text.replace(/\s+/g, ' ').trim().slice(0, 40), dryRun: !!opts.dryRun });
          return c.query(text, values);
        },
      };
      return fn(wrapped);
    }),
    runAsOwner: jest.fn(async (_p: string, fn: (c: any) => Promise<unknown>) => fn(client({ role: 'service_role' }))),
  };
}

/** ApiKeyGuard as it behaves, minus Keycloak: keys are literal, a Bearer `user-<sub>` is a signed-in user. */
@Injectable()
class FakeApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const apiKey = req.headers['apikey'] || req.query?.apikey;
    if (!apiKey) throw new UnauthorizedException('Missing apikey');
    if (apiKey !== PROJECT.anonKey && apiKey !== PROJECT.serviceKey) throw new UnauthorizedException('Invalid API key');
    const isService = apiKey === PROJECT.serviceKey;
    let dbRole: 'anon' | 'authenticated' | 'service_role' = isService ? 'service_role' : 'anon';
    let jwtClaims: Record<string, unknown> | undefined;
    const auth = req.headers['authorization'] as string | undefined;
    if (!isService && auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      if (token.startsWith('user-')) {
        dbRole = 'authenticated';
        jwtClaims = { sub: token.slice(5), email: `${token.slice(5)}@example.test` };
      } else if (token !== PROJECT.anonKey && token !== PROJECT.serviceKey) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
    }
    req.apiKeyPayload = { projectId: PROJECT.id, role: isService ? 'service' : 'anon', dbRole, jwtClaims };
    const scope = this.reflector.getAllAndOverride<string>(API_KEY_SCOPE_KEY, [context.getHandler(), context.getClass()]);
    if (scope === 'service' && !isService) throw new ForbiddenException('This route requires the service key');
    return true;
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

let app: INestApplication;
let base: string;
let store: FakeStore;
let runner: ReturnType<typeof rlsRunnerStub>;
let access: { resolveMode: jest.Mock; [k: string]: any };
let transformAvailable = true;

const anon = () => new StorageClient(`${base}/api/p/${PROJECT.id}/storage/v1`, { apikey: PROJECT.anonKey, Authorization: `Bearer ${PROJECT.anonKey}` });
const user = (sub: string) => new StorageClient(`${base}/api/p/${PROJECT.id}/storage/v1`, { apikey: PROJECT.anonKey, Authorization: `Bearer user-${sub}` });
const service = () => new StorageClient(`${base}/api/storage/v1`, { apikey: PROJECT.serviceKey, Authorization: `Bearer ${PROJECT.serviceKey}` });

beforeAll(async () => {
  store = new FakeStore();
  runner = rlsRunnerStub(store);
  const realAccess = new StorageAccessService({ storagePolicy: { findMany: jest.fn().mockResolvedValue([]) } } as any);
  access = {
    resolveMode: jest.fn().mockResolvedValue(null),
    assertCanRead: realAccess.assertCanRead.bind(realAccess),
    assertCanOverwrite: realAccess.assertCanOverwrite.bind(realAccess),
    assertCanModifyAll: jest.fn(async (caller: any, _p: string, bucket: string, keys: string[], statFn: any, verb: any) => {
      // Owner-only buckets: every key must be the caller's own, as the real rule does.
      if (caller.kind === 'service' || caller.kind === 'dashboard') return;
      const mode = await access.resolveMode('p1', bucket, keys[0] ?? '');
      if (mode !== 'owner-only') return;
      for (const key of keys) {
        const stat = await statFn(key);
        if (stat) realAccess.assertCanDelete(caller, mode, stat, key);
      }
      void verb;
    }),
    filterListing: realAccess.filterListing.bind(realAccess),
  };
  const transforms = {
    available: () => transformAvailable,
    limits: { cacheSeconds: 3600, maxSourceBytes: 25 * 1024 * 1024 },
    parseTransformQuery: (q: Record<string, unknown>) => {
      if (q.width === undefined && q.height === undefined && q.format === undefined) throw new Error('no transform');
      return { width: Number(q.width), fit: q.fit };
    },
    etagFor: (etag: string, opts: unknown) => `W/"${etag}-${JSON.stringify(opts)}"`,
    isTransformableSource: (type: string) => (type.startsWith('image/') ? { ok: true } : { ok: false, reason: 'type' }),
    tryAcquire: () => () => undefined,
    transform: (stream: Readable) => ({ stream, contentType: 'image/webp', format: 'webp' }),
  };
  const prisma = {
    project: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where?.id && where.id !== PROJECT.id) return null;
        return { ...PROJECT };
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    projectUsage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    projectActivityLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const catalog = {
    getBucketIfAvailable: jest.fn(async (_p: string, name: string) =>
      name === 'limited' ? { public: false, file_size_limit: 8, allowed_mime_types: ['text/*'] } : null,
    ),
    upsertBucket: jest.fn().mockResolvedValue(undefined),
    updateBucket: jest.fn().mockResolvedValue(undefined),
    emptyBucket: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: (k: string) => (k === 'STORAGE_URL_SIGNING_SECRET' ? 'test-signing-secret' : undefined) };

  const moduleRef = await Test.createTestingModule({
    controllers: [StorageV1PublicController, StorageV1Controller],
    providers: [
      StorageFacadeService,
      StorageSigningService,
      ProjectWakeService,
      { provide: PrismaService, useValue: prisma },
      { provide: StorageService, useValue: store },
      { provide: StorageAccessService, useValue: access },
      { provide: StorageCatalogService, useValue: catalog },
      { provide: ProjectRlsRunner, useValue: runner },
      { provide: ImageTransformService, useValue: transforms },
      { provide: ConfigService, useValue: config },
    ],
  })
    .overrideGuard(ApiKeyGuard)
    .useValue(new FakeApiKeyGuard(new Reflector()))
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  // What main.ts does for this surface: the /p/<projectId>/ prefix becomes a
  // header, and the JSON parser leaves uploads alone.
  app.use(rewriteSupabasePaths as any);
  (app as NestExpressApplication).useBodyParser('json', { limit: '10mb', type: isJsonBody as any });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  await app.listen(0);
  const address = app.getHttpServer().address();
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  PROJECT.storageAuthz = 'presets';
  PROJECT.status = 'ACTIVE';
  access.resolveMode.mockResolvedValue(null);
  runner.calls.length = 0;
  store.buckets.clear();
  store.catalog.clear();
  store.buckets.set('docs', { public: false, createdAt: '2026-10-28T00:00:00.000Z', objects: new Map() });
  store.buckets.set('public-docs', { public: true, createdAt: '2026-10-28T00:00:00.000Z', objects: new Map() });
});

const text = async (blob: Blob | null) => (blob ? Buffer.from(await blob.arrayBuffer()).toString('utf8') : null);

// ── Objects ───────────────────────────────────────────────────────────────────

describe('upload / update', () => {
  it('multipart (a Blob, under the empty field name) lands with its content type, cache directive and metadata', async () => {
    const { data, error } = await user('alice')
      .from('docs')
      .upload('reports/q4.txt', new Blob(['hello world'], { type: 'text/plain' }), { cacheControl: '600', metadata: { team: 'fin' } });
    expect(error).toBeNull();
    expect(data).toEqual({ path: 'reports/q4.txt', id: expect.any(String), fullPath: 'docs/reports/q4.txt' });
    const stored = store.buckets.get('docs')!.objects.get('reports/q4.txt')!;
    expect(stored.buf.toString()).toBe('hello world');
    expect(stored.contentType).toBe('text/plain');
    expect(stored.meta).toMatchObject({ 'x-amz-meta-owner': 'alice', 'Cache-Control': 'max-age=600', 'x-amz-meta-user-metadata': '{"team":"fin"}' });
  });

  it('a raw body streams through with the content-type header', async () => {
    const { data, error } = await user('alice').from('docs').upload('raw.bin', Buffer.from([1, 2, 3]), { contentType: 'application/octet-stream' });
    expect(error).toBeNull();
    expect(data?.fullPath).toBe('docs/raw.bin');
    expect(store.buckets.get('docs')!.objects.get('raw.bin')!.buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it('a JSON file is not eaten by the JSON body parser', async () => {
    const { error } = await user('alice').from('docs').upload('data.json', '{"a":1}', { contentType: 'application/json' });
    expect(error).toBeNull();
    expect(store.buckets.get('docs')!.objects.get('data.json')!.buf.toString()).toBe('{"a":1}');
  });

  it('refuses to overwrite without upsert — 409 Duplicate in Supabase\'s shape', async () => {
    await user('alice').from('docs').upload('a.txt', 'one');
    const { data, error } = await user('alice').from('docs').upload('a.txt', 'two');
    expect(data).toBeNull();
    expect(error).toBeInstanceOf(StorageApiError);
    expect((error as StorageApiError).status).toBe(400);
    expect((error as StorageApiError).statusCode).toBe('409');
    expect(error?.message).toBe('The resource already exists');
    expect(store.buckets.get('docs')!.objects.get('a.txt')!.buf.toString()).toBe('one');
  });

  it('upsert and update() overwrite', async () => {
    await user('alice').from('docs').upload('a.txt', 'one');
    expect((await user('alice').from('docs').upload('a.txt', 'two', { upsert: true })).error).toBeNull();
    expect(store.buckets.get('docs')!.objects.get('a.txt')!.buf.toString()).toBe('two');
    expect((await user('alice').from('docs').update('a.txt', 'three')).error).toBeNull();
    expect(store.buckets.get('docs')!.objects.get('a.txt')!.buf.toString()).toBe('three');
  });

  it('an unknown bucket is "Bucket not found"', async () => {
    const { error } = await user('alice').from('nope').upload('a.txt', 'x');
    expect((error as StorageApiError).statusCode).toBe('404');
    expect(error?.message).toBe('Bucket not found');
  });

  it('bucket limits from the catalog apply: size and mime type', async () => {
    store.buckets.set('limited', { public: false, createdAt: '', objects: new Map() });
    const tooBig = await user('alice').from('limited').upload('big.txt', 'more than eight bytes', { contentType: 'text/plain' });
    expect((tooBig.error as StorageApiError).statusCode).toBe('413');
    const wrongType = await user('alice').from('limited').upload('x.png', 'png', { contentType: 'image/png' });
    expect((wrongType.error as StorageApiError).statusCode).toBe('415');
    expect((await user('alice').from('limited').upload('ok.txt', 'tiny', { contentType: 'text/plain' })).error).toBeNull();
  });

  it('preset mode: a bare anon key cannot write', async () => {
    const { error } = await anon().from('docs').upload('a.txt', 'x');
    expect((error as StorageApiError).statusCode).toBe('403');
  });
});

describe('download / exists / info', () => {
  beforeEach(async () => {
    await user('alice').from('docs').upload('dir/file.txt', new Blob(['the bytes'], { type: 'text/plain' }), { cacheControl: '60' });
  });

  it('download returns the bytes', async () => {
    const { data, error } = await user('alice').from('docs').download('dir/file.txt');
    expect(error).toBeNull();
    expect(await text(data)).toBe('the bytes');
  });

  it('the byte response carries type, length, ETag, caching, ranges and a cross-origin policy', async () => {
    const res = await fetch(`${base}/api/storage/v1/object/docs/dir/file.txt`, { headers: { apikey: PROJECT.anonKey } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-length')).toBe('9');
    expect(res.headers.get('etag')).toMatch(/^".+"$/);
    expect(res.headers.get('cache-control')).toBe('max-age=60');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="file.txt"/);
    expect(res.headers.get('last-modified')).toBe('Wed, 28 Oct 2026 12:00:00 GMT');
    await res.arrayBuffer();
  });

  it('?download turns the response into an attachment, with an optional file name', async () => {
    const a = await fetch(`${base}/api/storage/v1/object/docs/dir/file.txt?download`, { headers: { apikey: PROJECT.anonKey } });
    expect(a.headers.get('content-disposition')).toMatch(/^attachment; filename="file.txt"/);
    await a.arrayBuffer();
    const b = await fetch(`${base}/api/storage/v1/object/docs/dir/file.txt?download=report.txt`, { headers: { apikey: PROJECT.anonKey } });
    expect(b.headers.get('content-disposition')).toMatch(/^attachment; filename="report.txt"/);
    await b.arrayBuffer();
  });

  it('honours a Range header with 206 and Content-Range', async () => {
    const res = await fetch(`${base}/api/storage/v1/object/docs/dir/file.txt`, { headers: { apikey: PROJECT.anonKey, range: 'bytes=4-6' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 4-6/9');
    expect(res.headers.get('content-length')).toBe('3');
    expect(await res.text()).toBe('byt');
    const bad = await fetch(`${base}/api/storage/v1/object/docs/dir/file.txt`, { headers: { apikey: PROJECT.anonKey, range: 'bytes=50-60' } });
    expect(bad.status).toBe(416);
    await bad.arrayBuffer();
  });

  it('exists() answers from HEAD: true, and false for a missing object', async () => {
    expect((await user('alice').from('docs').exists('dir/file.txt')).data).toBe(true);
    // A HEAD carries no body, so the client sees only the 400 — as against Supabase.
    const missing = await user('alice').from('docs').exists('dir/nope.txt');
    expect(missing.data).toBe(false);
    expect((missing.error as StorageApiError).status).toBe(400);
    const head = await fetch(`${base}/api/storage/v1/object/docs/dir/file.txt`, { method: 'HEAD', headers: { apikey: PROJECT.anonKey } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('9');
  });

  it('a missing object is 400 / statusCode "404" / not_found', async () => {
    const { data, error } = await user('alice').from('docs').download('dir/nope.txt');
    expect(data).toBeNull();
    expect((error as StorageApiError).status).toBe(400);
    expect((error as StorageApiError).statusCode).toBe('404');
    expect(error?.message).toBe('Object not found');
  });

  it('info() describes the object', async () => {
    const { data, error } = await user('alice').from('docs').info('dir/file.txt');
    expect(error).toBeNull();
    expect(data).toMatchObject({ name: 'dir/file.txt', bucketId: 'docs', size: 9, contentType: 'text/plain', cacheControl: 'max-age=60' });
  });

  it('download with a transform goes through the render route', async () => {
    await user('alice').from('docs').upload('pic.png', new Blob(['PNGDATA'], { type: 'image/png' }));
    const { data, error } = await user('alice').from('docs').download('pic.png', { transform: { width: 100 } });
    expect(error).toBeNull();
    expect(data?.type).toBe('image/webp');
    const notImage = await user('alice').from('docs').download('dir/file.txt', { transform: { width: 100 } });
    expect((notImage.error as StorageApiError).statusCode).toBe('415');
  });
});

describe('list', () => {
  beforeEach(async () => {
    const c = user('alice').from('docs');
    await c.upload('a/1.txt', 'x');
    await c.upload('a/b/2.txt', 'xx');
    await c.upload('c.txt', 'xxx');
    await c.upload('d.txt', 'xxxx');
  });

  it('root: folders first with null id and metadata, files with their metadata', async () => {
    const { data, error } = await user('alice').from('docs').list();
    expect(error).toBeNull();
    expect(data?.map((e) => e.name)).toEqual(['a', 'c.txt', 'd.txt']);
    expect(data?.[0]).toMatchObject({ name: 'a', id: null, metadata: null });
    expect(data?.[1]).toMatchObject({
      name: 'c.txt',
      id: expect.any(String),
      metadata: expect.objectContaining({ size: 3, mimetype: 'text/plain', contentLength: 3, httpStatusCode: 200, eTag: expect.any(String) }),
    });
  });

  it('a prefix lists what is directly beneath it', async () => {
    const { data } = await user('alice').from('docs').list('a');
    expect(data?.map((e) => e.name)).toEqual(['1.txt', 'b']);
  });

  it('sort, search, offset and limit', async () => {
    const desc = await user('alice').from('docs').list('', { sortBy: { column: 'name', order: 'desc' } });
    expect(desc.data?.map((e) => e.name)).toEqual(['d.txt', 'c.txt', 'a']);
    const found = await user('alice').from('docs').list('', { search: 'c' });
    expect(found.data?.map((e) => e.name)).toEqual(['c.txt']);
    const page = await user('alice').from('docs').list('', { limit: 1, offset: 1 });
    expect(page.data?.map((e) => e.name)).toEqual(['c.txt']);
  });
});

describe('remove', () => {
  it('deletes the named objects and returns them', async () => {
    const c = user('alice').from('docs');
    await c.upload('x.txt', '1');
    await c.upload('y.txt', '22');
    const { data, error } = await c.remove(['x.txt', 'y.txt', 'never.txt']);
    expect(error).toBeNull();
    expect(data?.map((e) => e.name)).toEqual(['x.txt', 'y.txt']);
    expect(data?.[1].metadata).toMatchObject({ size: 2 });
    expect((await c.exists('x.txt')).data).toBe(false);
  });
});

describe('signed URLs', () => {
  beforeEach(async () => {
    await user('alice').from('docs').upload('secret/doc.txt', 'classified', { contentType: 'text/plain' });
  });

  it('createSignedUrl mints a relative URL the client expands, and a plain GET on it streams the bytes', async () => {
    const { data, error } = await user('alice').from('docs').createSignedUrl('secret/doc.txt', 120);
    expect(error).toBeNull();
    expect(data?.signedUrl).toMatch(new RegExp(`^${base}/api/p/p1/storage/v1/object/sign/docs/secret/doc.txt\\?token=`));
    const res = await fetch(data!.signedUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('classified');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('a token opens exactly the object it was minted for, and only until it expires', async () => {
    const { data } = await user('alice').from('docs').createSignedUrl('secret/doc.txt', 120);
    const url = new URL(data!.signedUrl);
    const token = url.searchParams.get('token')!;
    const other = await fetch(`${base}/api/p/p1/storage/v1/object/sign/docs/secret/other.txt?token=${token}`);
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ statusCode: '401', error: 'InvalidJWT' });
    const forged = await fetch(`${data!.signedUrl.slice(0, -4)}xxxx`);
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ statusCode: '401', error: 'InvalidJWT' });
    const expired = jwt.sign({ kind: 'download', pid: 'p1', url: 'docs/secret/doc.txt' }, 'test-signing-secret', { algorithm: 'HS256', expiresIn: -10 });
    const late = await fetch(`${base}/api/p/p1/storage/v1/object/sign/docs/secret/doc.txt?token=${expired}`);
    expect(await late.json()).toMatchObject({ statusCode: '401', message: 'jwt expired' });
  });

  it('expiresIn is bounded, ?download works on the signed route, and a transform signs the render route', async () => {
    const bad = await user('alice').from('docs').createSignedUrl('secret/doc.txt', 0);
    expect((bad.error as StorageApiError).statusCode).toBe('400');
    const { data } = await user('alice').from('docs').createSignedUrl('secret/doc.txt', 60, { download: 'x.txt' });
    const res = await fetch(data!.signedUrl);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="x.txt"/);
    await res.arrayBuffer();
    await user('alice').from('docs').upload('pic.png', new Blob(['PNGDATA'], { type: 'image/png' }));
    const render = await user('alice').from('docs').createSignedUrl('pic.png', 60, { transform: { width: 50 } });
    expect(render.data?.signedUrl).toContain('/render/image/sign/docs/pic.png?token=');
    const img = await fetch(render.data!.signedUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/webp');
    await img.arrayBuffer();
  });

  it('createSignedUrls reports per path', async () => {
    const { data, error } = await user('alice').from('docs').createSignedUrls(['secret/doc.txt', 'missing.txt'], 60);
    expect(error).toBeNull();
    expect(data).toEqual([
      { error: null, path: 'secret/doc.txt', signedURL: expect.stringContaining('/object/sign/docs/secret/doc.txt?token='), signedUrl: expect.stringContaining(base) },
      { error: 'Object not found', path: 'missing.txt', signedURL: null, signedUrl: null },
    ]);
  });

  it('a signed URL is refused for an object the caller may not read', async () => {
    access.resolveMode.mockResolvedValue('owner-only');
    const { error } = await user('bob').from('docs').createSignedUrl('secret/doc.txt', 60);
    expect((error as StorageApiError).statusCode).toBe('403');
  });
});

describe('signed uploads', () => {
  it('createSignedUploadUrl then uploadToSignedUrl stores the object as the minting user', async () => {
    const { data, error } = await user('alice').from('docs').createSignedUploadUrl('incoming/u.txt');
    expect(error).toBeNull();
    expect(data).toEqual({ signedUrl: expect.stringContaining('/object/upload/sign/docs/incoming/u.txt?token='), path: 'incoming/u.txt', token: expect.any(String) });
    const anonymousClient = new StorageClient(`${base}/api/p/p1/storage/v1`, {});
    const put = await anonymousClient.from('docs').uploadToSignedUrl('incoming/u.txt', data!.token, Buffer.from('uploaded'), { contentType: 'text/plain' });
    expect(put.error).toBeNull();
    expect(put.data).toEqual({ path: 'incoming/u.txt', fullPath: 'docs/incoming/u.txt' });
    const stored = store.buckets.get('docs')!.objects.get('incoming/u.txt')!;
    expect(stored.buf.toString()).toBe('uploaded');
    expect(stored.meta['x-amz-meta-owner']).toBe('alice');
    // The token is for one object only, and without upsert the second attempt is a duplicate.
    const again = await anonymousClient.from('docs').uploadToSignedUrl('incoming/u.txt', data!.token, Buffer.from('again'));
    expect((again.error as StorageApiError).statusCode).toBe('409');
    const elsewhere = await anonymousClient.from('docs').uploadToSignedUrl('incoming/v.txt', data!.token, Buffer.from('x'));
    expect((elsewhere.error as StorageApiError).statusCode).toBe('401');
  });

  it('with upsert the signed upload may overwrite', async () => {
    await user('alice').from('docs').upload('incoming/u.txt', 'old');
    const { data } = await user('alice').from('docs').createSignedUploadUrl('incoming/u.txt', { upsert: true });
    const put = await new StorageClient(`${base}/api/p/p1/storage/v1`, {}).from('docs').uploadToSignedUrl('incoming/u.txt', data!.token, new Blob(['new']));
    expect(put.error).toBeNull();
    expect(store.buckets.get('docs')!.objects.get('incoming/u.txt')!.buf.toString()).toBe('new');
  });
});

describe('move / copy', () => {
  beforeEach(async () => {
    await user('alice').from('docs').upload('from/a.txt', 'moving');
  });

  it('move renames, also across buckets, and refuses to land on an existing object', async () => {
    const c = user('alice').from('docs');
    expect(await c.move('from/a.txt', 'to/b.txt')).toEqual({ data: { message: 'Successfully moved' }, error: null });
    expect((await c.exists('from/a.txt')).data).toBe(false);
    expect((await c.exists('to/b.txt')).data).toBe(true);
    expect(await c.move('to/b.txt', 'c.txt', { destinationBucket: 'public-docs' })).toEqual({ data: { message: 'Successfully moved' }, error: null });
    expect(store.buckets.get('public-docs')!.objects.has('c.txt')).toBe(true);
    await c.upload('x.txt', 'x');
    await c.upload('y.txt', 'y');
    expect(((await c.move('x.txt', 'y.txt')).error as StorageApiError).statusCode).toBe('409');
    expect(((await c.move('ghost.txt', 'z.txt')).error as StorageApiError).statusCode).toBe('404');
  });

  it('copy duplicates and answers the destination key', async () => {
    const c = user('alice').from('docs');
    expect(await c.copy('from/a.txt', 'copy/a.txt')).toEqual({ data: { path: 'docs/copy/a.txt' }, error: null });
    expect((await c.exists('from/a.txt')).data).toBe(true);
    expect(store.buckets.get('docs')!.objects.get('copy/a.txt')!.buf.toString()).toBe('moving');
    expect(((await c.copy('from/a.txt', 'copy/a.txt')).error as StorageApiError).statusCode).toBe('409');
  });
});

// ── Public URLs ───────────────────────────────────────────────────────────────

describe('public objects', () => {
  it('getPublicUrl points at a route that needs no key for a public bucket', async () => {
    await user('alice').from('public-docs').upload('logo.txt', 'LOGO', { contentType: 'text/plain' });
    const { data } = anon().from('public-docs').getPublicUrl('logo.txt');
    expect(data.publicUrl).toBe(`${base}/api/p/p1/storage/v1/object/public/public-docs/logo.txt`);
    const res = await fetch(data.publicUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('LOGO');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('a private bucket, a missing object and a missing project reference all answer not found', async () => {
    await user('alice').from('docs').upload('hidden.txt', 'x');
    const priv = await fetch(`${base}/api/p/p1/storage/v1/object/public/docs/hidden.txt`);
    expect(priv.status).toBe(400);
    expect(await priv.json()).toEqual({ statusCode: '404', error: 'not_found', message: 'Object not found' });
    const missing = await fetch(`${base}/api/p/p1/storage/v1/object/public/public-docs/none.txt`);
    expect(await missing.json()).toMatchObject({ statusCode: '404' });
    const noRef = await fetch(`${base}/api/storage/v1/object/public/public-docs/none.txt`);
    expect(await noRef.json()).toMatchObject({ statusCode: '400', error: 'InvalidRequest' });
  });

  it('a deactivated project is woken by a public request', async () => {
    await user('alice').from('public-docs').upload('logo.txt', 'LOGO');
    PROJECT.status = 'PAUSED';
    const res = await fetch(`${base}/api/p/p1/storage/v1/object/public/public-docs/logo.txt`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const prisma = app.get(PrismaService) as any;
    expect(prisma.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1', status: 'PAUSED' } }));
  });

  it('the public render route transforms', async () => {
    await user('alice').from('public-docs').upload('pic.png', new Blob(['PNG'], { type: 'image/png' }));
    const { data } = anon().from('public-docs').getPublicUrl('pic.png', { transform: { width: 20 } });
    expect(data.publicUrl).toContain('/render/image/public/public-docs/pic.png?width=20');
    const res = await fetch(data.publicUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    await res.arrayBuffer();
  });
});

// ── Buckets ───────────────────────────────────────────────────────────────────

describe('buckets', () => {
  it('CRUD with the service key', async () => {
    const s = service();
    expect(await s.createBucket('avatars', { public: true, fileSizeLimit: 1024, allowedMimeTypes: ['image/*'] })).toEqual({ data: { name: 'avatars' }, error: null });
    expect(store.buckets.get('avatars')?.public).toBe(true);
    expect((app.get(StorageCatalogService) as any).updateBucket).toHaveBeenCalledWith('p1', 'avatars', { public: true, fileSizeLimit: 1024, allowedMimeTypes: ['image/*'] });

    const dup = await s.createBucket('avatars');
    expect((dup.error as StorageApiError).statusCode).toBe('409');

    const got = await s.getBucket('avatars');
    expect(got.data).toMatchObject({ id: 'avatars', name: 'avatars', owner: '', public: true, file_size_limit: null, allowed_mime_types: null });
    expect(got.data?.created_at).toEqual(expect.any(String));

    const all = await s.listBuckets();
    expect(all.data?.map((b) => b.name)).toEqual(['avatars', 'docs', 'public-docs']);

    expect(await s.updateBucket('avatars', { public: false })).toEqual({ data: { message: 'Successfully updated' }, error: null });
    expect(store.buckets.get('avatars')?.public).toBe(false);

    await user('alice').from('avatars').upload('a.txt', 'x');
    const notEmpty = await s.deleteBucket('avatars');
    expect((notEmpty.error as StorageApiError).statusCode).toBe('409');
    expect(notEmpty.error?.message).toBe('The bucket you tried to delete is not empty');

    expect(await s.emptyBucket('avatars')).toEqual({ data: { message: 'Successfully emptied' }, error: null });
    expect(store.buckets.get('avatars')?.objects.size).toBe(0);
    expect(await s.deleteBucket('avatars')).toEqual({ data: { message: 'Successfully deleted' }, error: null });
    expect(store.buckets.has('avatars')).toBe(false);
    expect(((await s.getBucket('avatars')).error as StorageApiError).statusCode).toBe('404');
  });

  it('the anon key cannot administer buckets, and in preset mode cannot list them either', async () => {
    const created = await anon().createBucket('x-y-z');
    expect((created.error as StorageApiError).statusCode).toBe('403');
    expect(store.buckets.has('x-y-z')).toBe(false);
    expect(((await anon().listBuckets()).error as StorageApiError).statusCode).toBe('403');
    expect((await user('alice').listBuckets()).data?.map((b) => b.name)).toEqual(['docs', 'public-docs']);
  });
});

// ── Errors and keys ───────────────────────────────────────────────────────────

describe('error shape and key checks', () => {
  it('a missing or wrong apikey is reported in the same shape', async () => {
    const none = await fetch(`${base}/api/storage/v1/bucket`);
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ statusCode: '401', error: 'Unauthorized', message: 'Missing apikey' });
    const wrong = await new StorageClient(`${base}/api/storage/v1`, { apikey: 'nope' }).listBuckets();
    expect((wrong.error as StorageApiError).statusCode).toBe('401');
  });

  it('a key used under another project\'s /p/ prefix is refused', async () => {
    const c = new StorageClient(`${base}/api/p/p2/storage/v1`, { apikey: PROJECT.anonKey });
    const { error } = await c.from('docs').list();
    expect((error as StorageApiError).statusCode).toBe('403');
  });

  it('path traversal and empty keys are invalid', async () => {
    const res = await fetch(`${base}/api/storage/v1/object/docs/..%2Fetc%2Fpasswd`, { headers: { apikey: PROJECT.anonKey } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ statusCode: '400', error: 'InvalidRequest' });
  });

  it('validation errors from the request body are 400 with a message', async () => {
    const res = await fetch(`${base}/api/storage/v1/object/move`, {
      method: 'POST',
      headers: { apikey: PROJECT.anonKey, authorization: 'Bearer user-alice', 'content-type': 'application/json' },
      body: JSON.stringify({ bucketId: 'docs' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ statusCode: '400', error: 'InvalidRequest', message: 'Invalid object key' });
  });
});

// ── Preset rules ──────────────────────────────────────────────────────────────

describe('preset access rules', () => {
  it('owner-only: the uploader reads, deletes and lists; another user and the anon key do not', async () => {
    access.resolveMode.mockResolvedValue('owner-only');
    await user('alice').from('docs').upload('mine.txt', 'mine');
    expect(await text((await user('alice').from('docs').download('mine.txt')).data)).toBe('mine');
    expect(((await user('bob').from('docs').download('mine.txt')).error as StorageApiError).statusCode).toBe('403');
    expect(((await anon().from('docs').download('mine.txt')).error as StorageApiError).statusCode).toBe('403');
    expect((await user('bob').from('docs').list()).data).toEqual([]);
    expect((await user('alice').from('docs').list()).data?.map((e) => e.name)).toEqual(['mine.txt']);
    expect(((await user('bob').from('docs').remove(['mine.txt'])).error as StorageApiError).statusCode).toBe('403');
    expect(((await user('bob').from('docs').upload('mine.txt', 'taken', { upsert: true })).error as StorageApiError).statusCode).toBe('403');
    expect((await user('alice').from('docs').remove(['mine.txt'])).data?.map((e) => e.name)).toEqual(['mine.txt']);
  });

  it('authenticated-read: the anon key is refused, a signed-in user is not', async () => {
    access.resolveMode.mockResolvedValue('authenticated-read');
    await user('alice').from('docs').upload('shared.txt', 'shared');
    expect(((await anon().from('docs').download('shared.txt')).error as StorageApiError).statusCode).toBe('403');
    expect(await text((await user('bob').from('docs').download('shared.txt')).data)).toBe('shared');
    expect(((await anon().from('docs').list()).error as StorageApiError).statusCode).toBe('403');
  });
});

// ── RLS mode ──────────────────────────────────────────────────────────────────

describe('rls mode', () => {
  beforeEach(() => {
    PROJECT.storageAuthz = 'rls';
  });

  it('an upload is first tried as an INSERT under the caller\'s role and rolled back; anon is refused by policy', async () => {
    const denied = await anon().from('docs').upload('a.txt', 'x');
    expect((denied.error as StorageApiError).statusCode).toBe('403');
    expect(denied.error?.message).toBe('new row violates row-level security policy');
    expect(store.buckets.get('docs')!.objects.has('a.txt')).toBe(false);

    const ok = await user('alice').from('docs').upload('a.txt', 'x');
    expect(ok.error).toBeNull();
    const inserts = runner.calls.filter((c) => c.sql.startsWith('INSERT INTO storage.objects'));
    expect(inserts).toEqual([
      expect.objectContaining({ role: 'anon', dryRun: true }),
      expect.objectContaining({ role: 'authenticated', dryRun: true }),
    ]);
    expect(store.buckets.get('docs')!.objects.has('a.txt')).toBe(true);
  });

  it('download, info and signed URLs go through a SELECT the policies filter', async () => {
    await user('alice').from('docs').upload('a.txt', 'x');
    expect(((await anon().from('docs').download('a.txt')).error as StorageApiError).statusCode).toBe('404');
    expect(await text((await user('bob').from('docs').download('a.txt')).data)).toBe('x');
    expect(runner.calls.some((c) => c.role === 'anon' && c.sql.startsWith('SELECT id, bucket_id, name'))).toBe(true);
    expect((await anon().from('docs').exists('a.txt')).data).toBe(false);
    expect(((await anon().from('docs').createSignedUrl('a.txt', 60)).error as StorageApiError).statusCode).toBe('404');
    expect((await user('bob').from('docs').createSignedUrl('a.txt', 60)).error).toBeNull();
  });

  it('list runs the catalog query under the role', async () => {
    const c = user('alice').from('docs');
    await c.upload('a/1.txt', 'x');
    await c.upload('b.txt', 'xx');
    const { data, error } = await c.list();
    expect(error).toBeNull();
    expect(data?.map((e) => e.name)).toEqual(['a', 'b.txt']);
    expect(data?.[1].metadata).toMatchObject({ size: 2, mimetype: 'text/plain;charset=UTF-8' });
    expect(runner.calls.some((c) => c.sql.startsWith('WITH scoped AS') && c.role === 'authenticated')).toBe(true);
    expect((await anon().from('docs').list()).data).toEqual([]);
  });

  it('remove deletes the rows the policies allow and then the objects', async () => {
    await user('alice').from('docs').upload('a.txt', 'x');
    await user('bob').from('docs').upload('b.txt', 'y');
    const { data } = await user('alice').from('docs').remove(['a.txt', 'b.txt']);
    expect(data?.map((e) => e.name)).toEqual(['a.txt']);
    expect(store.buckets.get('docs')!.objects.has('a.txt')).toBe(false);
    expect(store.buckets.get('docs')!.objects.has('b.txt')).toBe(true);
  });

  it('move and copy are judged on the catalog row', async () => {
    await user('alice').from('docs').upload('a.txt', 'x');
    expect(((await user('bob').from('docs').move('a.txt', 'b.txt')).error as StorageApiError).statusCode).toBe('404');
    expect((await user('alice').from('docs').move('a.txt', 'b.txt')).error).toBeNull();
    expect(store.catalog.has('docs/b.txt')).toBe(true);
    expect((await user('bob').from('docs').copy('b.txt', 'c.txt')).error).toBeNull();
    expect(store.catalog.get('docs/c.txt')?.owner_id).toBe('bob');
  });

  it('buckets are read from storage.buckets under the role', async () => {
    const { data } = await anon().listBuckets();
    expect(data?.map((b) => b.name)).toEqual(['docs', 'public-docs']);
    expect(data?.[1]).toMatchObject({ public: true, owner: '', file_size_limit: null });
    expect((await anon().getBucket('docs')).data?.id).toBe('docs');
  });

  it('a project whose database has no catalog is told what to run', async () => {
    runner.runRlsTransaction.mockRejectedValueOnce(Object.assign(new Error('relation "storage.objects" does not exist'), { code: '42P01' }));
    const { error } = await user('alice').from('docs').list();
    expect((error as StorageApiError).status).toBe(500);
    expect(error?.message).toMatch(/ensure-rls-bootstrap/);
  });
});
