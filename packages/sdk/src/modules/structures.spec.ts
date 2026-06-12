import { describe, it, expect, vi } from 'vitest';
import { StructuresClient } from './structures.js';
import type { BasefyioFetchClient } from '../lib/fetch.js';
import type { UpdateStructureInput } from './structures.js';

function makeHttp(response: any): BasefyioFetchClient {
  return { json: vi.fn().mockResolvedValue(response) } as any;
}

describe('StructuresClient', () => {
  const PROJECT = 'proj-abc';

  describe('list()', () => {
    it('GET to the correct URL and returns array', async () => {
      const structures = [
        { id: 's1', name: 'Customers', kind: 'relational' },
        { id: 's2', name: 'Events', kind: 'json' },
      ];
      const http = makeHttp(structures);
      const client = new StructuresClient(http);
      const result = await client.list(PROJECT);
      expect((http.json as any).mock.calls[0][0]).toBe(`/v1/projects/${PROJECT}/structures`);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Customers');
    });

    it('URL-encodes projectId', async () => {
      const http = makeHttp([]);
      const client = new StructuresClient(http);
      await client.list('proj abc');
      expect((http.json as any).mock.calls[0][0]).toContain('proj%20abc');
    });
  });

  describe('create()', () => {
    it('POST to correct URL with name and relational kind', async () => {
      const created = { id: 's3', name: 'Customers', kind: 'relational' };
      const http = makeHttp(created);
      const client = new StructuresClient(http);
      await client.create(PROJECT, { name: 'Customers', kind: 'relational' });
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/structures`);
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ name: 'Customers', kind: 'relational' });
    });

    it('body contains kind: "json" when called with json kind', async () => {
      const created = { id: 's4', name: 'Events', kind: 'json' };
      const http = makeHttp(created);
      const client = new StructuresClient(http);
      await client.create(PROJECT, { name: 'Events', kind: 'json' });
      const body = JSON.parse((http.json as any).mock.calls[0][1].body);
      expect(body.kind).toBe('json');
    });

    it('returns the response object from the server', async () => {
      const created = { id: 's5', name: 'Orders', kind: 'relational', badge: 'SQL' };
      const http = makeHttp(created);
      const client = new StructuresClient(http);
      const result = await client.create(PROJECT, { name: 'Orders', kind: 'relational' });
      expect(result.badge).toBe('SQL');
      expect(result.id).toBe('s5');
    });
  });

  describe('get()', () => {
    it('GET to the correct URL with structureId', async () => {
      const structure = { id: 'ds-1', name: 'orders', kind: 'relational', badge: 'SQL' };
      const http = makeHttp(structure);
      const client = new StructuresClient(http);
      const result = await client.get(PROJECT, 'ds-1');
      expect((http.json as any).mock.calls[0][0]).toBe(`/v1/projects/${PROJECT}/structures/ds-1`);
      expect(result.id).toBe('ds-1');
    });

    it('URL-encodes both projectId and structureId', async () => {
      const http = makeHttp({});
      const client = new StructuresClient(http);
      await client.get('proj abc', 'ds 1');
      expect((http.json as any).mock.calls[0][0]).toContain('proj%20abc');
      expect((http.json as any).mock.calls[0][0]).toContain('ds%201');
    });
  });

  describe('update()', () => {
    it('PATCH to correct URL with name in body', async () => {
      const updated = { id: 'ds-1', name: 'customers', kind: 'relational' };
      const http = makeHttp(updated);
      const client = new StructuresClient(http);
      const input: UpdateStructureInput = { name: 'customers' };
      const result = await client.update(PROJECT, 'ds-1', input);
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/structures/ds-1`);
      expect(opts.method).toBe('PATCH');
      expect(JSON.parse(opts.body)).toEqual({ name: 'customers' });
      expect(result.name).toBe('customers');
    });
  });

  describe('delete()', () => {
    it('DELETE to correct URL', async () => {
      const http = makeHttp(undefined);
      const client = new StructuresClient(http);
      await client.delete(PROJECT, 'ds-1');
      const [url, opts] = (http.json as any).mock.calls[0];
      expect(url).toBe(`/v1/projects/${PROJECT}/structures/ds-1`);
      expect(opts.method).toBe('DELETE');
    });
  });
});
