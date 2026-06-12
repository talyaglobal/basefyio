import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrationsClient } from './migrations.js';
import type { BasefyioFetchClient } from '../lib/fetch.js';

function makeHttp(response: any): BasefyioFetchClient {
  return { json: vi.fn().mockResolvedValue(response) } as any;
}

describe('MigrationsClient', () => {
  const PROJECT = 'proj-abc';
  const RUN_ID = 'run-xyz';

  describe('planMigration()', () => {
    it('POST to /migrations/plan with empty opts', async () => {
      const http = makeHttp({ migrationRunId: RUN_ID, fromVersion: 1, toVersion: 2, plan: {}, sqlStatements: [] });
      const client = new MigrationsClient(http);
      const result = await client.planMigration(PROJECT);
      expect((http.json as any).mock.calls[0][0]).toBe(`/v1/projects/${PROJECT}/migrations/plan`);
      expect(result.migrationRunId).toBe(RUN_ID);
    });

    it('passes fromVersion and toVersion in body', async () => {
      const http = makeHttp({ migrationRunId: RUN_ID, fromVersion: 2, toVersion: 3, plan: {}, sqlStatements: [] });
      const client = new MigrationsClient(http);
      await client.planMigration(PROJECT, { fromVersion: 2, toVersion: 3 });
      const callOpts = (http.json as any).mock.calls[0][1];
      expect(JSON.parse(callOpts.body)).toEqual({ fromVersion: 2, toVersion: 3 });
    });

    it('encodes projectId in URL', async () => {
      const http = makeHttp({});
      const client = new MigrationsClient(http);
      await client.planMigration('proj with spaces').catch(() => {});
      expect((http.json as any).mock.calls[0][0]).toContain('proj%20with%20spaces');
    });
  });

  describe('applyMigration()', () => {
    it('POST to /migrations/apply with migrationRunId', async () => {
      const http = makeHttp({ migrationRunId: RUN_ID, status: 'APPLIED', appliedStatements: 3 });
      const client = new MigrationsClient(http);
      const result = await client.applyMigration(PROJECT, RUN_ID);
      expect((http.json as any).mock.calls[0][0]).toContain('/migrations/apply');
      expect(result.status).toBe('APPLIED');
    });

    it('passes force flag in body', async () => {
      const http = makeHttp({ migrationRunId: RUN_ID, status: 'APPLIED', appliedStatements: 1 });
      const client = new MigrationsClient(http);
      await client.applyMigration(PROJECT, RUN_ID, { force: true });
      const body = JSON.parse((http.json as any).mock.calls[0][1].body);
      expect(body.force).toBe(true);
    });
  });

  describe('listMigrations()', () => {
    it('GET /migrations and returns array', async () => {
      const runs = [{ id: 'r1', status: 'APPLIED', fromBlueprintVersion: 1, toBlueprintVersion: 2 }];
      const http = makeHttp(runs);
      const client = new MigrationsClient(http);
      const result = await client.listMigrations(PROJECT);
      expect((http.json as any).mock.calls[0][0]).toBe(`/v1/projects/${PROJECT}/migrations`);
      expect(result).toHaveLength(1);
    });
  });

  describe('getMigration()', () => {
    it('GET /migrations/:id and returns run', async () => {
      const run = { id: RUN_ID, status: 'PENDING' };
      const http = makeHttp(run);
      const client = new MigrationsClient(http);
      const result = await client.getMigration(PROJECT, RUN_ID);
      expect((http.json as any).mock.calls[0][0]).toContain(RUN_ID);
      expect(result.id).toBe(RUN_ID);
    });
  });
});
