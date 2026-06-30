// Maps a Playground action to the *real* REST request the hosted basefyio
// platform would receive — and the equivalent @basefyio/sdk call. The numbers
// run in-browser, but this panel shows users exactly how to do the same thing
// against a live project once they sign up.

export interface RestRequest {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  sdk: string;
}

// Public marketing host — the SDK's HttpClient mounts everything under `/api`
// (see packages/sdk/src/http.ts), and SQL goes through POST /api/sql/execute
// with { projectId, query } (see packages/sdk/src/resources/sql.ts).
const DEMO_HOST = 'https://api.basefy.io';
export const DEMO_PROJECT = 'demo';

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer YOUR_API_KEY',
  };
}

/** Every data operation in basefyio flows through the SQL execute endpoint. */
export function sqlExecuteRequest(query: string): RestRequest {
  const body = { projectId: DEMO_PROJECT, query, limit: 100 };
  const path = '/api/sql/execute';
  return {
    method: 'POST',
    path,
    url: `${DEMO_HOST}${path}`,
    headers: authHeaders(),
    body,
    sdk: [
      "import { createPlatformClient } from '@basefyio/sdk';",
      '',
      `const basefy = createPlatformClient({ url: '${DEMO_HOST}', apiKey: process.env.BASEFY_API_KEY });`,
      '',
      `const result = await basefy`,
      `  .withProject('${DEMO_PROJECT}')`,
      `  .sql.execute(${JSON.stringify(query)});`,
    ].join('\n'),
  };
}

export function listBucketsRequest(): RestRequest {
  const path = `/api/projects/${DEMO_PROJECT}/storage/buckets`;
  return {
    method: 'GET',
    path,
    url: `${DEMO_HOST}${path}`,
    headers: { Authorization: 'Bearer YOUR_API_KEY' },
    sdk: `await basefy.withProject('${DEMO_PROJECT}').storage.listBuckets();`,
  };
}

export function listObjectsRequest(bucket: string): RestRequest {
  const path = `/api/projects/${DEMO_PROJECT}/storage/buckets/${bucket}/objects`;
  return {
    method: 'GET',
    path,
    url: `${DEMO_HOST}${path}`,
    headers: { Authorization: 'Bearer YOUR_API_KEY' },
    sdk: `await basefy.withProject('${DEMO_PROJECT}').storage.listObjects('${bucket}');`,
  };
}

export function downloadObjectRequest(bucket: string, key: string): RestRequest {
  const path = `/api/projects/${DEMO_PROJECT}/storage/buckets/${bucket}/objects/url`;
  return {
    method: 'GET',
    path: `${path}?key=${encodeURIComponent(key)}&download=true`,
    url: `${DEMO_HOST}${path}?key=${encodeURIComponent(key)}&download=true`,
    headers: { Authorization: 'Bearer YOUR_API_KEY' },
    sdk: `await basefy.withProject('${DEMO_PROJECT}').storage.getObjectUrl('${bucket}', '${key}', { download: true });`,
  };
}

/** Render a copyable curl command for a request descriptor. */
export function toCurl(req: RestRequest): string {
  const lines = [`curl -X ${req.method} '${req.url}'`];
  for (const [k, v] of Object.entries(req.headers)) {
    lines.push(`  -H '${k}: ${v}'`);
  }
  if (req.body !== undefined) {
    lines.push(`  -d '${JSON.stringify(req.body)}'`);
  }
  return lines.join(' \\\n');
}
