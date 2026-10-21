const fsp = {
  readdir: jest.fn(),
  stat: jest.fn(),
  unlink: jest.fn(),
};
jest.mock('fs/promises', () => fsp);
jest.mock('fs', () => ({ mkdirSync: jest.fn() }));

import { PayloadTooLargeException } from '@nestjs/common';
import {
  ContentLengthGuard,
  Semaphore,
  SPOOL_SUFFIX,
  removeSpooled,
  resolveMaxConcurrentUploads,
  resolveMaxUploadBytes,
  spoolMulterOptions,
  sweepSpool,
} from './upload-spool';

beforeEach(() => {
  fsp.readdir.mockReset();
  fsp.stat.mockReset();
  fsp.unlink.mockReset();
});

describe('resolveMaxUploadBytes', () => {
  const fallback = 500 * 1024 * 1024;

  it('uses the code default when the env is absent or nonsense', () => {
    expect(resolveMaxUploadBytes(fallback, undefined)).toBe(fallback);
    expect(resolveMaxUploadBytes(fallback, '')).toBe(fallback);
    expect(resolveMaxUploadBytes(fallback, 'lots')).toBe(fallback);
    expect(resolveMaxUploadBytes(fallback, '0')).toBe(fallback);
    expect(resolveMaxUploadBytes(fallback, '-5')).toBe(fallback);
  });

  it('converts STORAGE_MAX_UPLOAD_MB to bytes', () => {
    expect(resolveMaxUploadBytes(fallback, '50')).toBe(50 * 1024 * 1024);
    expect(resolveMaxUploadBytes(fallback, '1024')).toBe(1024 * 1024 * 1024);
  });
});

describe('resolveMaxConcurrentUploads', () => {
  it('defaults to 8 and accepts positive integers only', () => {
    expect(resolveMaxConcurrentUploads(undefined)).toBe(8);
    expect(resolveMaxConcurrentUploads('3')).toBe(3);
    expect(resolveMaxConcurrentUploads('0')).toBe(8);
    expect(resolveMaxConcurrentUploads('2.5')).toBe(8);
  });
});

describe('spoolMulterOptions', () => {
  it('sets the byte limit, one file per request and disk storage', () => {
    const opts = spoolMulterOptions(123);
    expect(opts.limits).toEqual({ fileSize: 123, files: 1 });
    expect(opts.storage).toBeDefined();
  });
});

describe('removeSpooled', () => {
  it('ignores a missing path and an already-removed file but surfaces other errors', async () => {
    await removeSpooled(undefined);
    expect(fsp.unlink).not.toHaveBeenCalled();

    fsp.unlink.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await expect(removeSpooled('/tmp/x.part')).resolves.toBeUndefined();

    fsp.unlink.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    await expect(removeSpooled('/tmp/y.part')).rejects.toThrow('busy');
  });
});

describe('sweepSpool', () => {
  const now = 10_000_000;
  const file = (ageMs: number, isFile = true) => ({ isFile: () => isFile, mtimeMs: now - ageMs });

  it('removes only old .part files and leaves everything else alone', async () => {
    fsp.readdir.mockResolvedValue(['old.part', 'fresh.part', 'notes.txt', 'dir.part']);
    fsp.stat.mockImplementation(async (p: string) => {
      if (p.endsWith('old.part')) return file(5000);
      if (p.endsWith('fresh.part')) return file(10);
      if (p.endsWith('dir.part')) return file(5000, false);
      throw new Error('should not stat ' + p);
    });
    fsp.unlink.mockResolvedValue(undefined);

    const removed = await sweepSpool(1000, '/spool', now);

    expect(removed).toBe(1);
    expect(fsp.unlink).toHaveBeenCalledTimes(1);
    expect(String(fsp.unlink.mock.calls[0][0])).toMatch(/old\.part$/);
    expect(fsp.stat).not.toHaveBeenCalledWith(expect.stringMatching(/notes\.txt$/));
  });

  it('treats a missing spool directory as empty', async () => {
    fsp.readdir.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await sweepSpool(1000, '/missing', now)).toBe(0);
  });

  it('keeps going when a file vanishes between readdir and unlink', async () => {
    fsp.readdir.mockResolvedValue(['a.part', 'b.part']);
    fsp.stat.mockResolvedValue(file(5000));
    fsp.unlink
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(undefined);
    expect(await sweepSpool(1000, '/spool', now)).toBe(1);
  });

  it('uses the .part suffix constant', () => {
    expect(SPOOL_SUFFIX).toBe('.part');
  });
});

describe('Semaphore', () => {
  it('hands out capacity slots and releases idempotently', () => {
    const s = new Semaphore(2);
    const a = s.tryAcquire();
    const b = s.tryAcquire();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(s.tryAcquire()).toBeNull();
    expect(s.inUse).toBe(2);
    a!();
    a!();
    expect(s.inUse).toBe(1);
    expect(s.tryAcquire()).toBeTruthy();
  });
});

describe('ContentLengthGuard', () => {
  const ctx = (headers: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as any;
  const guard = new ContentLengthGuard(10 * 1024 * 1024);

  it('passes requests without a Content-Length and those within the limit', () => {
    expect(guard.canActivate(ctx({}))).toBe(true);
    expect(guard.canActivate(ctx({ 'content-length': String(10 * 1024 * 1024) }))).toBe(true);
    // Up to 1 MiB of multipart framing is tolerated.
    expect(guard.canActivate(ctx({ 'content-length': String(11 * 1024 * 1024) }))).toBe(true);
  });

  it('refuses a body that is clearly too large before any byte is spooled', () => {
    expect(() => guard.canActivate(ctx({ 'content-length': String(11 * 1024 * 1024 + 1) }))).toThrow(
      PayloadTooLargeException,
    );
    expect(() => guard.canActivate(ctx({ 'content-length': String(2 * 1024 * 1024 * 1024) }))).toThrow(
      /upload limit of 10 MB/,
    );
  });
});
