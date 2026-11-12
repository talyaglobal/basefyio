import { describe, expect, it } from 'vitest';
import { StorageBucketApi, StorageClient } from './storage';

interface Call {
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
}

type Handler = (call: Call, index: number) => Promise<unknown> | unknown;

/** A stand-in for BasefyioFetchClient that records calls and lets each test script the answers. */
function fakeHttp(handle: Handler) {
  const calls: Call[] = [];
  const http = {
    getBaseUrl: () => 'https://api.example.com/api',
    getApiKey: () => 'anon key',
    async json(path: string, init: any = {}) {
      const call = { path, method: init.method ?? 'GET', headers: init.headers, body: init.body };
      calls.push(call);
      return handle(call, calls.length - 1);
    },
    async request(path: string, init: any = {}) {
      const call = { path, method: init.method ?? 'GET', headers: init.headers, body: init.body };
      calls.push(call);
      return handle(call, calls.length - 1);
    },
  };
  return { http: http as never, calls };
}

const BASE = '/projects/project-1/storage/buckets/avatars';

function session(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 's1',
    bucket: 'avatars',
    path: 'big.bin',
    offset: 0,
    size: 10,
    chunkSize: 4,
    contentType: 'application/octet-stream',
    status: 'active',
    expiresAt: '2026-10-21T00:00:00Z',
    ...overrides,
  };
}

/** A PATCH answer the way the API sends it: 200 + the session with its new offset. */
function patched(offset: number) {
  return {
    data: session({ offset }),
    response: new Response(null, { status: 200, headers: { 'Upload-Offset': String(offset) } }),
  };
}

const stored = { name: 'big.bin', size: 10, contentType: 'application/octet-stream', lastModified: 'x', etag: 'e' };

function bucket(http: never) {
  return new StorageBucketApi(http, 'project-1', 'avatars');
}

describe('getPublicUrl', () => {
  const { http } = fakeHttp(() => undefined);

  it('without a transform is the public file route, which needs no key at all', () => {
    const url = bucket(http).getPublicUrl('folder/a b.png');
    expect(url).toBe(
      'https://api.example.com/api/projects/project-1/storage/public/avatars?path=folder%2Fa%20b.png',
    );
    expect(url).not.toContain('apikey');
  });

  it('with a transform points at the render route and carries the public key', () => {
    expect(bucket(http).getPublicUrl('a.png', { transform: { width: 200, format: 'webp' } })).toBe(
      'https://api.example.com/api/projects/project-1/storage/buckets/avatars/objects/render?path=a.png&width=200&format=webp&apikey=anon%20key',
    );
  });

  it('emits the options in a fixed order and skips the ones not given', () => {
    const url = bucket(http).getPublicUrl('a.png', {
      transform: { fit: 'inside', quality: 70, height: 100, width: undefined },
    });
    expect(url).toContain('/objects/render?path=a.png&height=100&quality=70&fit=inside&apikey=');
    expect(url).not.toContain('width=');
  });

  it('treats an empty transform object like no transform', () => {
    expect(bucket(http).getPublicUrl('a.png', {})).toBe(bucket(http).getPublicUrl('a.png'));
  });
});

describe('uploadResumable', () => {
  const bytes = new Uint8Array(10).map((_, i) => i);

  it('opens a session, sends every chunk at the right offset and completes', async () => {
    const progress: number[] = [];
    const { http, calls } = fakeHttp((call) => {
      if (call.method === 'POST' && call.path === `${BASE}/upload-sessions`) return session();
      if (call.method === 'PATCH') {
        const offset = Number(call.headers!['Upload-Offset']);
        return patched(offset + (call.body as Blob).size);
      }
      if (call.method === 'POST' && call.path.endsWith('/complete')) return stored;
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    const { data, error } = await bucket(http).uploadResumable('big.bin', bytes, {
      contentType: 'application/octet-stream',
      onProgress: (p) => progress.push(p.percent),
    });

    expect(error).toBeNull();
    expect(data).toEqual({ ...stored, sessionId: 's1' });

    const create = calls[0];
    expect(JSON.parse(create.body as string)).toEqual({ path: 'big.bin', size: 10, contentType: 'application/octet-stream' });

    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.headers!['Upload-Offset'])).toEqual(['0', '4', '8']);
    expect(patches.map((c) => (c.body as Blob).size)).toEqual([4, 4, 2]);
    expect(patches.every((c) => c.headers!['Content-Type'] === 'application/offset+octet-stream')).toBe(true);
    expect(calls[calls.length - 1]).toMatchObject({ method: 'POST', path: `${BASE}/upload-sessions/s1/complete` });
    expect(progress).toEqual([0, 40, 80, 100]);
  });

  it('re-reads the offset after a 409 and continues from there', async () => {
    let failedOnce = false;
    const { http, calls } = fakeHttp((call) => {
      if (call.method === 'POST' && call.path === `${BASE}/upload-sessions`) return session();
      if (call.method === 'PATCH') {
        const offset = Number(call.headers!['Upload-Offset']);
        if (offset === 4 && !failedOnce) {
          failedOnce = true;
          throw { message: 'Upload offset mismatch', status: 409 };
        }
        return patched(offset + (call.body as Blob).size);
      }
      if (call.method === 'GET') return session({ offset: 8 }); // the server had already stored chunk 2
      if (call.path.endsWith('/complete')) return stored;
      throw new Error('unexpected');
    });

    const { data, error } = await bucket(http).uploadResumable('big.bin', bytes, { retryDelayMs: 1 });

    expect(error).toBeNull();
    expect(data?.sessionId).toBe('s1');
    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.headers!['Upload-Offset']);
    expect(patches).toEqual(['0', '4', '8']);
    expect(calls.some((c) => c.method === 'GET' && c.path === `${BASE}/upload-sessions/s1`)).toBe(true);
  });

  it('gives up after maxRetries consecutive failures', async () => {
    const { http, calls } = fakeHttp((call) => {
      if (call.method === 'POST') return session();
      if (call.method === 'PATCH') throw { message: 'gateway', status: 502 };
      if (call.method === 'GET') return session({ offset: 0 });
      throw new Error('unexpected');
    });

    const { data, error } = await bucket(http).uploadResumable('big.bin', bytes, { maxRetries: 2, retryDelayMs: 1 });

    expect(data).toBeNull();
    expect(error).toEqual({ message: 'gateway', status: 502 });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3);
  });

  it('does not retry a request the server called wrong', async () => {
    const { http, calls } = fakeHttp((call) => {
      if (call.method === 'POST') return session();
      if (call.method === 'PATCH') throw { message: 'not yours', status: 403 };
      throw new Error('unexpected');
    });

    const { error } = await bucket(http).uploadResumable('big.bin', bytes, { retryDelayMs: 1 });

    expect(error?.status).toBe(403);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('aborts the session when the signal fires', async () => {
    const controller = new AbortController();
    const { http, calls } = fakeHttp((call) => {
      if (call.method === 'POST') return session();
      if (call.method === 'PATCH') {
        controller.abort();
        const offset = Number(call.headers!['Upload-Offset']);
        return patched(offset + (call.body as Blob).size);
      }
      if (call.method === 'DELETE') return { id: 's1', status: 'aborted' };
      throw new Error('unexpected');
    });

    const { data, error } = await bucket(http).uploadResumable('big.bin', bytes, { signal: controller.signal });

    expect(data).toBeNull();
    expect(error?.message).toBe('Upload aborted');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `${BASE}/upload-sessions/s1`)).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });

  it('resumeUpload continues from the stored offset and refuses a file of the wrong size', async () => {
    const { http, calls } = fakeHttp((call) => {
      if (call.method === 'GET') return session({ offset: 8 });
      if (call.method === 'PATCH') return patched(10);
      if (call.path.endsWith('/complete')) return stored;
      throw new Error('unexpected');
    });

    const ok = await bucket(http).resumeUpload('s1', bytes);
    expect(ok.error).toBeNull();
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.headers!['Upload-Offset'])).toEqual(['8']);

    const wrong = await bucket(http).resumeUpload('s1', new Uint8Array(3));
    expect(wrong.error).toEqual({ message: 'File is 3 bytes but the session expects 10', status: 400 });
  });

  it('exposes the session primitives', async () => {
    const { http, calls } = fakeHttp((call) => {
      if (call.method === 'POST') return session({ chunkSize: 8 * 1024 * 1024 });
      if (call.method === 'GET') return session({ offset: 3 });
      if (call.method === 'DELETE') return { id: 's1', status: 'aborted' };
      throw new Error('unexpected');
    });
    const b = bucket(http);
    expect((await b.createUploadSession('a.bin', 100, { chunkSize: 8 * 1024 * 1024 })).data?.chunkSize).toBe(8 * 1024 * 1024);
    expect(JSON.parse(calls[0].body as string)).toEqual({ path: 'a.bin', size: 100, chunkSize: 8 * 1024 * 1024 });
    expect((await b.getUploadSession('s1')).data?.offset).toBe(3);
    expect((await b.abortUpload('s1')).data).toEqual({ id: 's1', status: 'aborted' });
  });
});

describe('access rules', () => {
  it('reads, sets and removes bucket rules through the service-key routes', async () => {
    const { http, calls } = fakeHttp((call) => {
      if (call.method === 'GET') return [{ id: 'p', bucket: 'avatars', pathPrefix: '', mode: 'owner-only' }];
      if (call.method === 'PUT') return { id: 'p', bucket: 'avatars', pathPrefix: 'private/', mode: 'authenticated-read' };
      if (call.method === 'DELETE') return { removed: 1 };
      throw new Error('unexpected');
    });
    const client = new StorageClient(http, 'project-1');

    expect((await client.getPolicies()).data).toHaveLength(1);
    expect(calls[0].path).toBe('/projects/project-1/storage/policies');

    const set = await client.setBucketPolicy('avatars', { mode: 'authenticated-read', pathPrefix: 'private/' });
    expect(set.data?.mode).toBe('authenticated-read');
    expect(calls[1]).toMatchObject({ method: 'PUT', path: `${BASE}/policy` });
    expect(JSON.parse(calls[1].body as string)).toEqual({ mode: 'authenticated-read', pathPrefix: 'private/' });

    expect((await client.removeBucketPolicy('avatars', 'private/')).data).toEqual({ removed: 1 });
    expect(calls[2]).toMatchObject({ method: 'DELETE', path: `${BASE}/policy?pathPrefix=private%2F` });
  });
});

describe('objects', () => {
  it('upload sends the contentType it was given, even for a Blob that has its own', async () => {
    const { http, calls } = fakeHttp(() => ({ data: stored, response: new Response(null) }));
    await bucket(http).upload('a/photo.jpg', new Blob([new Uint8Array([1, 2])], { type: 'application/octet-stream' }), {
      contentType: 'image/jpeg',
    });
    const part = (calls[0].body as FormData).get('file') as File;
    expect(part.type).toBe('image/jpeg');
    expect(part.name).toBe('photo.jpg');
    expect(calls[0].path).toBe(`${BASE}/objects?path=a%2Fphoto.jpg`);

    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    await bucket(http).upload('b.png', blob);
    expect(((calls[1].body as FormData).get('file') as File).type).toBe('image/png');
  });

  it('createSignedUrl takes the lifetime as a number or as { expiresIn }', async () => {
    const { http, calls } = fakeHttp(() => ({ url: 'https://s/x', expiresIn: 60 }));
    await bucket(http).createSignedUrl('a.txt', 60);
    await bucket(http).createSignedUrl('a.txt', { expiresIn: 120 });
    await bucket(http).createSignedUrl('a.txt');
    expect(calls.map((c) => c.path)).toEqual([
      `${BASE}/objects/url?path=a.txt&expiry=60`,
      `${BASE}/objects/url?path=a.txt&expiry=120`,
      `${BASE}/objects/url?path=a.txt&expiry=3600`,
    ]);
  });

  it('list passes its options as query parameters and nothing when there are none', async () => {
    const { http, calls } = fakeHttp(() => []);
    await bucket(http).list();
    await bucket(http).list('docs/', { search: 'inv', sortBy: 'size', order: 'desc', limit: 50, offset: 100, recursive: true });
    expect(calls[0].path).toBe(`${BASE}/objects`);
    expect(calls[1].path).toBe(
      `${BASE}/objects?prefix=docs%2F&recursive=true&search=inv&sortBy=size&order=desc&limit=50&offset=100`,
    );
  });

  it('copy and move post their paths and overwrite', async () => {
    const { http, calls } = fakeHttp((call) =>
      call.path.endsWith('/copy') ? { from: 'a', to: 'b', copied: 1 } : { from: 'a', to: 'c', moved: 1 },
    );
    expect((await bucket(http).copy('a', 'b')).data).toEqual({ from: 'a', to: 'b', copied: 1 });
    expect((await bucket(http).move('a', 'c', { overwrite: true })).data).toEqual({ from: 'a', to: 'c', moved: 1 });
    expect(calls.map((c) => [c.method, c.path, JSON.parse(c.body as string)])).toEqual([
      ['POST', `${BASE}/objects/copy`, { from: 'a', to: 'b', overwrite: false }],
      ['POST', `${BASE}/objects/rename`, { from: 'a', to: 'c', overwrite: true }],
    ]);
  });

  it('remove hands back what went and what was not there', async () => {
    const answer = { message: 'Deleted 1 object(s); 1 not found', deleted: ['a'], notFound: ['b'] };
    const { http } = fakeHttp(() => answer);
    expect((await bucket(http).remove(['a', 'b'])).data).toEqual(answer);
  });

  it('fetchPublicUrl asks the API for the storage address', async () => {
    const { http, calls } = fakeHttp(() => ({ public: true, url: 'https://storage.example.com/bf-x-avatars/a.png' }));
    expect((await bucket(http).fetchPublicUrl('a.png')).data).toEqual({
      public: true,
      publicUrl: 'https://storage.example.com/bf-x-avatars/a.png',
    });
    expect(calls[0].path).toBe(`${BASE}/public-url?path=a.png`);
  });
});

describe('buckets', () => {
  it('deleteBucket forces only when asked to', async () => {
    const { http, calls } = fakeHttp(() => ({ message: 'deleted' }));
    const client = new StorageClient(http, 'project-1');
    await client.deleteBucket('avatars');
    await client.deleteBucket('avatars', { force: true });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['DELETE', BASE],
      ['DELETE', `${BASE}?force=true`],
    ]);
  });

  it('createBucket and updateBucket send upload limits only when given', async () => {
    const { http, calls } = fakeHttp(() => ({}));
    const client = new StorageClient(http, 'project-1');
    await client.createBucket('avatars');
    await client.createBucket('avatars', { public: true, fileSizeLimit: 1024, allowedMimeTypes: ['image/*'] });
    await client.updateBucket('avatars', { fileSizeLimit: null });
    expect(calls.map((c) => JSON.parse(c.body as string))).toEqual([
      { name: 'avatars', public: false },
      { name: 'avatars', public: true, fileSizeLimit: 1024, allowedMimeTypes: ['image/*'] },
      { fileSizeLimit: null },
    ]);
  });
});
