/**
 * Provider Contract Test Suite — Phase 2
 *
 * These tests predate both providers in git history.
 * Every provider MUST pass this suite. No provider may have tests that
 * contradict or bypass this shared suite.
 *
 * Usage:
 *   providerContractSuite('NoSql', () => new NoSqlDataEngine(config));
 *   providerContractSuite('Postgres', () => new PostgresDataEngine(config));
 */

import type { DataEngine, EntityCollection } from '../interfaces/data-engine';
import {
  DocumentNotFoundError,
  ConcurrencyError,
  DocumentTooLargeError,
  QueryValidationError,
} from '../interfaces/data-engine';
import type {
  DocResult,
  JsonObject,
  Page,
  WriteOpts,
} from '../interfaces/types';
import type {
  EntityQuery,
  Filter,
  IndexDef,
} from '../interfaces/query';

// ── Test Constants ─────────────────────────────────────────

const PROJECT_A = 'prj_test_a';
const PROJECT_B = 'prj_test_b';
const ENTITY = 'patients';
const USER_ID = 'user_test1';

// ── Contract Suite ─────────────────────────────────────────

export function providerContractSuite(
  providerName: string,
  factory: () => DataEngine | Promise<DataEngine>,
) {
  describe(`DataEngine Provider Contract: ${providerName}`, () => {
    let engine: DataEngine;

    beforeAll(async () => {
      engine = await factory();
      // Provision test tenants
      await engine.provisionTenant(PROJECT_A);
      await engine.provisionTenant(PROJECT_B);
    });

    afterAll(async () => {
      await engine.deprovisionTenant(PROJECT_A);
      await engine.deprovisionTenant(PROJECT_B);
    });

    // ── Ping ─────────────────────────────────────────────

    describe('ping', () => {
      it('should return true when store is healthy', async () => {
        const ok = await engine.ping();
        expect(ok).toBe(true);
      });
    });

    // ── Capabilities ─────────────────────────────────────

    describe('capabilities', () => {
      it('should return a ProviderCapabilities object', () => {
        const caps = engine.capabilities();
        expect(typeof caps.transactions).toBe('boolean');
        expect(typeof caps.fullTextSearch).toBe('boolean');
        expect(typeof caps.vectorSearch).toBe('boolean');
        expect(typeof caps.ttl).toBe('boolean');
        expect(typeof caps.aggregationPipeline).toBe('boolean');
      });
    });

    // ── Flat CRUD ────────────────────────────────────────

    describe('flat document CRUD', () => {
      let col: EntityCollection;
      let insertedId: string;
      let insertedVersion: number;

      beforeAll(() => {
        col = engine.collection(PROJECT_A, ENTITY);
      });

      it('should insert a flat document', async () => {
        const doc = { firstName: 'John', lastName: 'Smith', age: 35 };
        const result = await col.insert(doc, { userId: USER_ID });

        expect(result._id).toBeDefined();
        expect(result._entity).toBe(ENTITY);
        expect(result._projectId).toBe(PROJECT_A);
        expect(result._version).toBeGreaterThanOrEqual(1);
        expect(result._status).toBe('active');
        expect(result._createdBy).toBe(USER_ID);
        expect(result._createdAt).toBeDefined();
        expect(result.firstName).toBe('John');
        expect(result.lastName).toBe('Smith');

        insertedId = result._id;
        insertedVersion = result._version;
      });

      it('should get a document by ID', async () => {
        const result = await col.get(insertedId);
        expect(result).not.toBeNull();
        expect(result!._id).toBe(insertedId);
        expect(result!.firstName).toBe('John');
      });

      it('should return null for non-existent ID', async () => {
        const result = await col.get('nonexistent_id_12345');
        expect(result).toBeNull();
      });

      it('should partial-update a document', async () => {
        const result = await col.update(insertedId, { age: 36 }, { userId: USER_ID });
        expect(result._id).toBe(insertedId);
        expect(result.age).toBe(36);
        expect(result.firstName).toBe('John');
        expect(result._version).toBeGreaterThan(insertedVersion);
      });

      it('should replace a document', async () => {
        const result = await col.replace(
          insertedId,
          { firstName: 'Jane', lastName: 'Doe', age: 28 },
          { userId: USER_ID },
        );
        expect(result._id).toBe(insertedId);
        expect(result.firstName).toBe('Jane');
        expect(result.lastName).toBe('Doe');
      });

      it('should soft-delete a document', async () => {
        await col.delete(insertedId, { userId: USER_ID });

        // After soft-delete, get should return null (excluded by default)
        const result = await col.get(insertedId);
        expect(result).toBeNull();
      });

      it('should count documents', async () => {
        // Insert a fresh one
        await col.insert({ firstName: 'Counter', lastName: 'Test' }, { userId: USER_ID });
        const count = await col.count();
        expect(count).toBeGreaterThanOrEqual(1);
      });
    });

    // ── Nested Object CRUD ───────────────────────────────

    describe('nested object CRUD', () => {
      let col: EntityCollection;
      let docId: string;

      beforeAll(() => {
        col = engine.collection(PROJECT_A, 'orders');
      });

      it('should insert a document with nested objects', async () => {
        const doc = {
          customer: {
            name: 'ACME Corp',
            address: { city: 'New York', country: 'US', zip: '10001' },
          },
          total: 999.99,
        };
        const result = await col.insert(doc, { userId: USER_ID });
        expect(result._id).toBeDefined();
        expect((result.customer as JsonObject).name).toBe('ACME Corp');
        expect(((result.customer as JsonObject).address as JsonObject).city).toBe('New York');
        docId = result._id;
      });

      it('should update nested fields via partial patch', async () => {
        const result = await col.update(docId, {
          customer: { name: 'ACME Corp', address: { city: 'Boston', country: 'US', zip: '02101' } },
        });
        expect(((result.customer as JsonObject).address as JsonObject).city).toBe('Boston');
      });
    });

    // ── Array of Objects CRUD ────────────────────────────

    describe('array of objects CRUD', () => {
      let col: EntityCollection;
      let docId: string;

      beforeAll(() => {
        col = engine.collection(PROJECT_A, 'invoices');
      });

      it('should insert a document with arrays of objects', async () => {
        const doc = {
          invoiceNumber: 'INV-001',
          lineItems: [
            { productId: 'p1', name: 'Widget', quantity: 10, price: 5.99 },
            { productId: 'p2', name: 'Gadget', quantity: 2, price: 29.99 },
          ],
          tags: ['urgent', 'wholesale'],
        };
        const result = await col.insert(doc, { userId: USER_ID });
        expect(result._id).toBeDefined();
        expect((result.lineItems as JsonObject[]).length).toBe(2);
        expect((result.tags as string[]).length).toBe(2);
        docId = result._id;
      });

      it('should retrieve arrays intact', async () => {
        const result = await col.get(docId);
        expect(result).not.toBeNull();
        const items = result!.lineItems as JsonObject[];
        expect(items[0].name).toBe('Widget');
        expect(items[1].quantity).toBe(2);
      });
    });

    // ── Nested Path Filter ───────────────────────────────

    describe('nested path filtering', () => {
      let col: EntityCollection;

      beforeAll(async () => {
        col = engine.collection(PROJECT_A, 'customers');
        await col.insert({ name: 'Alpha', address: { city: 'New York', country: 'US' } }, { userId: USER_ID });
        await col.insert({ name: 'Beta', address: { city: 'London', country: 'UK' } }, { userId: USER_ID });
        await col.insert({ name: 'Gamma', address: { city: 'New York', country: 'US' } }, { userId: USER_ID });
      });

      it('should filter on nested field path', async () => {
        const q: EntityQuery = {
          entity: 'customers',
          filter: {
            type: 'field',
            path: { path: 'address.city', isArrayPath: false },
            operator: 'eq',
            value: 'New York',
          },
        };
        const result = await col.query(q);
        expect(result.data.length).toBe(2);
        expect(result.data.every((d) => (d.address as JsonObject).city === 'New York')).toBe(true);
      });
    });

    // ── Array Path Filter ────────────────────────────────

    describe('array path filtering', () => {
      let col: EntityCollection;

      beforeAll(async () => {
        col = engine.collection(PROJECT_A, 'articles');
        await col.insert({ title: 'TS Guide', tags: ['typescript', 'javascript'] }, { userId: USER_ID });
        await col.insert({ title: 'Go Guide', tags: ['golang', 'backend'] }, { userId: USER_ID });
        await col.insert({ title: 'Full Stack', tags: ['typescript', 'golang'] }, { userId: USER_ID });
      });

      it('should filter with array contains operator', async () => {
        const q: EntityQuery = {
          entity: 'articles',
          filter: {
            type: 'field',
            path: { path: 'tags', isArrayPath: true },
            operator: 'contains',
            value: 'typescript',
          },
        };
        const result = await col.query(q);
        expect(result.data.length).toBe(2);
      });
    });

    // ── Mandatory _projectId Injection ───────────────────

    describe('mandatory _projectId injection (SECURITY)', () => {
      it('project A cannot see project B data', async () => {
        const colA = engine.collection(PROJECT_A, 'secrets');
        const colB = engine.collection(PROJECT_B, 'secrets');

        await colA.insert({ secret: 'A-secret-value' }, { userId: USER_ID });
        await colB.insert({ secret: 'B-secret-value' }, { userId: USER_ID });

        // Query from project A should only see A's data
        const resultA = await colA.query({ entity: 'secrets' });
        expect(resultA.data.every((d) => d._projectId === PROJECT_A)).toBe(true);
        expect(resultA.data.some((d) => d.secret === 'A-secret-value')).toBe(true);
        expect(resultA.data.some((d) => d.secret === 'B-secret-value')).toBe(false);

        // Query from project B should only see B's data
        const resultB = await colB.query({ entity: 'secrets' });
        expect(resultB.data.every((d) => d._projectId === PROJECT_B)).toBe(true);
        expect(resultB.data.some((d) => d.secret === 'B-secret-value')).toBe(true);
        expect(resultB.data.some((d) => d.secret === 'A-secret-value')).toBe(false);
      });

      it('get by ID across projects returns null (not found)', async () => {
        const colA = engine.collection(PROJECT_A, 'crosstest');
        const inserted = await colA.insert({ data: 'project-A-only' }, { userId: USER_ID });

        // Try to read from project B — must return null
        const colB = engine.collection(PROJECT_B, 'crosstest');
        const result = await colB.get(inserted._id);
        expect(result).toBeNull();
      });
    });

    // ── CAS Concurrency Conflict ─────────────────────────

    describe('optimistic concurrency (CAS)', () => {
      it('should reject update with stale version', async () => {
        const col = engine.collection(PROJECT_A, 'cas_test');
        const doc = await col.insert({ value: 'initial' }, { userId: USER_ID });

        // Update once to advance version
        await col.update(doc._id, { value: 'updated1' });

        // Try to update with the original (now stale) version
        await expect(
          col.update(doc._id, { value: 'conflict' }, { ifMatch: doc._version }),
        ).rejects.toThrow(ConcurrencyError);
      });
    });

    // ── Soft Delete ──────────────────────────────────────

    describe('soft delete', () => {
      it('should soft-delete and exclude from queries', async () => {
        const col = engine.collection(PROJECT_A, 'soft_del');
        const doc = await col.insert({ name: 'To Be Deleted' }, { userId: USER_ID });

        await col.delete(doc._id);

        // Default query excludes soft-deleted
        const result = await col.query({ entity: 'soft_del' });
        expect(result.data.find((d) => d._id === doc._id)).toBeUndefined();
      });

      it('should include soft-deleted when explicitly requested', async () => {
        const col = engine.collection(PROJECT_A, 'soft_del2');
        const doc = await col.insert({ name: 'Ghost' }, { userId: USER_ID });
        await col.delete(doc._id);

        const result = await col.query({
          entity: 'soft_del2',
          includeSoftDeleted: true,
        });
        const found = result.data.find((d) => d._id === doc._id);
        expect(found).toBeDefined();
        expect(found!._status).toBe('deleted');
        expect(found!._deletedAt).not.toBeNull();
      });
    });

    // ── Indexes ──────────────────────────────────────────

    describe('indexes', () => {
      it('should ensure indexes without error (idempotent)', async () => {
        const col = engine.collection(PROJECT_A, 'indexed_entity');
        const indexes: IndexDef[] = [
          { name: 'idx_name', fields: [{ path: 'name' }] },
          { name: 'idx_city', fields: [{ path: 'address.city' }] },
        ];

        // Should not throw
        await col.ensureIndexes(indexes);
        // Idempotent — second call should also not throw
        await col.ensureIndexes(indexes);
      });
    });

    // ── Pagination ───────────────────────────────────────

    describe('pagination', () => {
      let col: EntityCollection;

      beforeAll(async () => {
        col = engine.collection(PROJECT_A, 'paginated');
        for (let i = 0; i < 25; i++) {
          await col.insert({ index: i, name: `Item ${i}` }, { userId: USER_ID });
        }
      });

      it('should respect limit', async () => {
        const result = await col.query({ entity: 'paginated', limit: 10 });
        expect(result.data.length).toBe(10);
        expect(result.hasMore).toBe(true);
        expect(result.total).toBeGreaterThanOrEqual(25);
      });

      it('should respect offset', async () => {
        const page1 = await col.query({ entity: 'paginated', limit: 10, offset: 0 });
        const page2 = await col.query({ entity: 'paginated', limit: 10, offset: 10 });

        const ids1 = new Set(page1.data.map((d) => d._id));
        const ids2 = new Set(page2.data.map((d) => d._id));

        // No overlap between pages
        for (const id of ids2) {
          expect(ids1.has(id)).toBe(false);
        }
      });
    });

    // ── Sort ─────────────────────────────────────────────

    describe('sorting', () => {
      let col: EntityCollection;

      beforeAll(async () => {
        col = engine.collection(PROJECT_A, 'sorted');
        await col.insert({ name: 'Charlie', score: 30 }, { userId: USER_ID });
        await col.insert({ name: 'Alice', score: 10 }, { userId: USER_ID });
        await col.insert({ name: 'Bob', score: 20 }, { userId: USER_ID });
      });

      it('should sort ascending', async () => {
        const result = await col.query({
          entity: 'sorted',
          sort: [{ path: { path: 'score', isArrayPath: false }, direction: 'asc' }],
        });
        const scores = result.data.map((d) => d.score as number);
        expect(scores).toEqual([...scores].sort((a, b) => a - b));
      });

      it('should sort descending', async () => {
        const result = await col.query({
          entity: 'sorted',
          sort: [{ path: { path: 'score', isArrayPath: false }, direction: 'desc' }],
        });
        const scores = result.data.map((d) => d.score as number);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
      });
    });
  });
}
