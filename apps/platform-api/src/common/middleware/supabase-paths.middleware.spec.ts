import { isFormBody, isJsonBody, isRawStorageUpload, rewriteSupabasePaths } from './supabase-paths.middleware';

function run(url: string, method = 'GET') {
  const req: any = { url, method, headers: {}, socket: { setTimeout: jest.fn() } };
  const next = jest.fn();
  rewriteSupabasePaths(req, {}, next);
  expect(next).toHaveBeenCalled();
  return req;
}

describe('rewriteSupabasePaths', () => {
  it('puts the Supabase service paths under the global prefix', () => {
    expect(run('/auth/v1/token?grant_type=password', 'POST').url).toBe('/api/auth/v1/token?grant_type=password');
    expect(run('/rest/v1/todos?select=*').url).toBe('/api/rest/v1/todos?select=*');
    expect(run('/storage/v1/object/public/a.png').url).toBe('/api/storage/v1/object/public/a.png');
    expect(run('/realtime/v1/websocket').url).toBe('/api/realtime/v1/websocket');
  });

  it('leaves every other path alone', () => {
    expect(run('/api/projects').url).toBe('/api/projects');
    expect(run('/health').url).toBe('/health');
    expect(run('/authority/v1/x').url).toBe('/authority/v1/x');
  });

  it('turns /api/p/<projectId>/… into the project headers', () => {
    const req = run('/api/p/proj_123/auth/v1/authorize?provider=google');
    expect(req.url).toBe('/api/auth/v1/authorize?provider=google');
    expect(req.headers['x-bf-project']).toBe('proj_123');
    expect(req.headers['x-project-id']).toBe('proj_123');
  });

  it('accepts the project-scoped base without the prefix too', () => {
    const req = run('/p/proj_123/rest/v1/todos');
    expect(req.url).toBe('/api/rest/v1/todos');
    expect(req.headers['x-bf-project']).toBe('proj_123');
  });

  it('a bare project base resolves to the API root', () => {
    expect(run('/api/p/proj_123').url).toBe('/api/');
  });

  it('bounds every socket but an upload', () => {
    expect(run('/api/rest/v1/todos').socket.setTimeout).toHaveBeenCalledWith(120_000);
    expect(run('/api/storage/v1/object/photos/a.png', 'PUT').socket.setTimeout).not.toHaveBeenCalled();
  });
});

describe('isRawStorageUpload', () => {
  it('is the object upload routes and nothing else', () => {
    expect(isRawStorageUpload({ method: 'POST', url: '/api/storage/v1/object/photos/a.json' })).toBe(true);
    expect(isRawStorageUpload({ method: 'PUT', url: '/storage/v1/object/photos/a.json?x=1' })).toBe(true);
    expect(isRawStorageUpload({ method: 'GET', url: '/api/storage/v1/object/photos/a.json' })).toBe(false);
    expect(isRawStorageUpload({ method: 'POST', url: '/api/storage/v1/object/list/photos' })).toBe(false);
    expect(isRawStorageUpload({ method: 'POST', url: '/api/storage/v1/object/sign/photos/a' })).toBe(false);
    expect(isRawStorageUpload({ method: 'POST', url: '/api/storage/v1/object/move' })).toBe(false);
    expect(isRawStorageUpload({ method: 'POST', url: '/api/storage/v1/object/copy' })).toBe(false);
    expect(isRawStorageUpload({ method: 'POST', url: '/api/storage/v1/object/upload/sign/photos/a' })).toBe(false);
    expect(isRawStorageUpload({ method: 'PUT', url: '/api/storage/v1/object/upload/sign/photos/a' })).toBe(true);
    expect(isRawStorageUpload({ method: 'POST', url: '/api/storage/v1/bucket' })).toBe(false);
    expect(isRawStorageUpload({ method: 'POST', url: '/api/auth/v1/token' })).toBe(false);
  });
});

describe('body predicates', () => {
  it('parse JSON and forms everywhere except on a raw upload', () => {
    expect(isJsonBody({ method: 'POST', url: '/api/auth/v1/token', headers: { 'content-type': 'application/json; charset=utf-8' } })).toBe(true);
    expect(isJsonBody({ method: 'POST', url: '/api/auth/v1/token', headers: { 'content-type': 'application/vnd.pgrst.object+json' } })).toBe(true);
    expect(isJsonBody({ method: 'POST', url: '/api/storage/v1/object/photos/data.json', headers: { 'content-type': 'application/json' } })).toBe(false);
    expect(isJsonBody({ method: 'POST', url: '/api/storage/v1/object/list/photos', headers: { 'content-type': 'application/json' } })).toBe(true);
    expect(isJsonBody({ method: 'POST', url: '/api/auth/v1/token', headers: { 'content-type': 'text/plain' } })).toBe(false);
    expect(isFormBody({ method: 'POST', url: '/api/x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).toBe(true);
    expect(isFormBody({ method: 'PUT', url: '/api/storage/v1/object/b/f', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).toBe(false);
  });
});
