import { describe, it, expect, vi } from 'vitest';
import { AccessClient } from './access.js';
import type { BasefyioFetchClient } from '../lib/fetch.js';

function makeHttp(response: any): BasefyioFetchClient {
  return { json: vi.fn().mockResolvedValue(response) } as any;
}

function makeHttpRejecting(error: any): BasefyioFetchClient {
  return { json: vi.fn().mockRejectedValue(error) } as any;
}

const SAMPLE_ENDPOINT = {
  engineType: 'postgres',
  host: 'db.example.com',
  port: 5432,
  username: 'readonly_user',
  database: 'app_db',
  requiresClientCert: false,
  accessLevel: 'read',
  active: true,
  connectionString: 'postgresql://readonly_user@db.example.com:5432/app_db',
  sslMode: 'require',
  snippets: {
    psql: "psql 'postgresql://readonly_user@db.example.com:5432/app_db?sslmode=require'",
  },
};

describe('AccessClient', () => {
  const PROJECT_ID = 'proj-123';

  describe('getProjectAccess()', () => {
    it('happy path — GETs /v1/projects/proj-123/access and returns ProjectAccessInfo with one endpoint', async () => {
      const response = {
        projectId: PROJECT_ID,
        slug: 'my-project',
        endpoints: [SAMPLE_ENDPOINT],
        entitlements: { externalDbAccess: true },
      };
      const http = makeHttp(response);
      const client = new AccessClient(http);

      const result = await client.getProjectAccess(PROJECT_ID);

      expect((http.json as any).mock.calls[0][0]).toBe(`/v1/projects/${PROJECT_ID}/access`);
      expect(result.projectId).toBe(PROJECT_ID);
      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].host).toBe('db.example.com');
    });

    it('URL-encoding — projectId "my project" produces a URL containing "my%20project"', async () => {
      const http = makeHttp({
        projectId: 'my project',
        slug: 'my-project',
        endpoints: [],
        entitlements: {},
      });
      const client = new AccessClient(http);

      await client.getProjectAccess('my project');

      const calledUrl: string = (http.json as any).mock.calls[0][0];
      expect(calledUrl).toContain('my%20project');
      expect(calledUrl).not.toContain('my project');
    });

    it('403 surface — propagates the error without silent swallowing', async () => {
      const err = { status: 403, message: 'Plan does not include feature: externalDbAccess' };
      const http = makeHttpRejecting(err);
      const client = new AccessClient(http);

      await expect(client.getProjectAccess(PROJECT_ID)).rejects.toMatchObject({
        status: 403,
        message: 'Plan does not include feature: externalDbAccess',
      });
    });

    it('response shape — returned object has endpoints, entitlements, and slug fields; warning is optional', async () => {
      const response = {
        projectId: PROJECT_ID,
        slug: 'my-project',
        endpoints: [SAMPLE_ENDPOINT],
        entitlements: { externalDbAccess: true, mTLS: false },
        warning: 'Feature is in beta.',
      };
      const http = makeHttp(response);
      const client = new AccessClient(http);

      const result = await client.getProjectAccess(PROJECT_ID);

      expect(result).toHaveProperty('endpoints');
      expect(result).toHaveProperty('entitlements');
      expect(result).toHaveProperty('slug');
      expect(result.warning).toBe('Feature is in beta.');

      // warning is optional — a response without it is also valid
      const noWarnHttp = makeHttp({ ...response, warning: undefined });
      const noWarnClient = new AccessClient(noWarnHttp);
      const noWarnResult = await noWarnClient.getProjectAccess(PROJECT_ID);
      expect(noWarnResult.warning).toBeUndefined();
    });

    it('no secrets in response — mock response object does NOT contain keys password, token, secret, or apiKey', async () => {
      const response = {
        projectId: PROJECT_ID,
        slug: 'my-project',
        endpoints: [SAMPLE_ENDPOINT],
        entitlements: { externalDbAccess: true },
      };
      const http = makeHttp(response);
      const client = new AccessClient(http);

      const result = await client.getProjectAccess(PROJECT_ID);

      // Scan all JSON keys recursively via serialisation
      const serialized = JSON.stringify(result);
      const allKeys = [...serialized.matchAll(/"([^"]+)":/g)].map(m => m[1].toLowerCase());
      const forbidden = ['password', 'token', 'secret', 'apikey'];
      for (const key of allKeys) {
        expect(forbidden, `Unexpected sensitive key in response: "${key}"`).not.toContain(key);
      }
    });
  });
});
