import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { StorageFacadeError } from './storage-facade.errors';
import { DEFAULT_SIGNED_URL_MAX_SECONDS, SIGNED_UPLOAD_SECONDS, StorageSigningService } from './storage-signing.service';

const project = { id: 'p1', serviceKey: 'svc-secret' };
const other = { id: 'p2', serviceKey: 'svc-other' };

function build(env: Record<string, string | undefined> = {}) {
  const config = { get: (k: string) => env[k] };
  return new StorageSigningService(config as any);
}

let warn: jest.SpyInstance;
beforeAll(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
beforeEach(() => warn.mockClear());

describe('StorageSigningService', () => {
  it('signs with the shared secret when configured, HS256, and verifies object and purpose', () => {
    const svc = build({ STORAGE_URL_SIGNING_SECRET: 'shared' });
    expect(warn).not.toHaveBeenCalled();
    const token = svc.signDownload(project, 'docs', 'a/b.txt', 60, { width: 10 });
    expect(jwt.verify(token, 'shared')).toMatchObject({ kind: 'download', pid: 'p1', url: 'docs/a/b.txt', t: { width: 10 } });
    expect(svc.verify(token, project, 'download', 'docs', 'a/b.txt').t).toEqual({ width: 10 });
    expect(() => svc.verify(token, project, 'download', 'docs', 'a/c.txt')).toThrow(StorageFacadeError);
    expect(() => svc.verify(token, project, 'upload', 'docs', 'a/b.txt')).toThrow(/not issued for this object/);
    expect(() => svc.verify(token, other, 'download', 'docs', 'a/b.txt')).toThrow(StorageFacadeError);
  });

  it('without a shared secret each project signs with a key derived from its service key', () => {
    const svc = build();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('STORAGE_URL_SIGNING_SECRET'));
    const token = svc.signUpload(project, 'docs', 'in.txt', 'alice', true);
    expect(svc.verify(token, project, 'upload', 'docs', 'in.txt')).toMatchObject({ owner: 'alice', upsert: true });
    expect(() => svc.verify(token, other, 'upload', 'docs', 'in.txt')).toThrow(StorageFacadeError);
    const decoded = jwt.decode(token) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(SIGNED_UPLOAD_SECONDS);
  });

  it('peekProjectId reads the project before verification; garbage is an InvalidJWT', () => {
    const svc = build({ STORAGE_URL_SIGNING_SECRET: 's' });
    expect(svc.peekProjectId(svc.signDownload(project, 'b', 'k', 10))).toBe('p1');
    expect(() => svc.peekProjectId('not-a-jwt')).toThrow(StorageFacadeError);
    expect(() => svc.verify('not-a-jwt', project, 'download', 'b', 'k')).toThrow(/Invalid or expired token/);
  });

  it('bounds expiresIn by STORAGE_SIGNED_URL_MAX_SECONDS', () => {
    expect(build().maxSeconds).toBe(DEFAULT_SIGNED_URL_MAX_SECONDS);
    const svc = build({ STORAGE_SIGNED_URL_MAX_SECONDS: '600' });
    expect(svc.validateExpiry('600')).toBe(600);
    expect(() => svc.validateExpiry(601)).toThrow(/between 1 and 600/);
    expect(() => svc.validateExpiry(0)).toThrow(StorageFacadeError);
    expect(() => svc.validateExpiry('1.5')).toThrow(StorageFacadeError);
  });
});
