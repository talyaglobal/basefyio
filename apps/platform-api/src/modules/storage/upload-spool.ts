import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { readdir, stat, unlink } from 'fs/promises';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Uploads are written to a disk spool and streamed to the object store from
 * there, instead of being held in memory. A 500 MB upload then costs 500 MB of
 * scratch disk for a few seconds rather than 500 MB of heap on a host that
 * also runs the database.
 */

export const SPOOL_SUFFIX = '.part';
/** Spool files older than this are leftovers from a crash and are removed by the hourly sweep. */
export const SPOOL_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Multipart framing around the file itself (boundaries, headers). */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/** `STORAGE_MAX_UPLOAD_MB` as bytes, else the code default handed in. */
export function resolveMaxUploadBytes(
  fallbackBytes: number,
  envValue: string | undefined = process.env.STORAGE_MAX_UPLOAD_MB,
): number {
  const mb = Number(envValue);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : fallbackBytes;
}

/** `STORAGE_MAX_CONCURRENT_UPLOADS`, else 8. */
export function resolveMaxConcurrentUploads(
  envValue: string | undefined = process.env.STORAGE_MAX_CONCURRENT_UPLOADS,
): number {
  const n = Number(envValue);
  return Number.isInteger(n) && n > 0 ? n : 8;
}

let spoolDir: string | undefined;

/** `STORAGE_UPLOAD_TMP_DIR`, else `<os tmp>/basefyio-uploads`; created on first use. */
export function uploadSpoolDir(): string {
  if (spoolDir) return spoolDir;
  const configured = (process.env.STORAGE_UPLOAD_TMP_DIR || '').trim();
  const preferred = configured || join(tmpdir(), 'basefyio-uploads');
  try {
    mkdirSync(preferred, { recursive: true });
    spoolDir = preferred;
  } catch {
    // An unwritable configured directory must not stop uploads altogether.
    spoolDir = tmpdir();
  }
  return spoolDir;
}

/** Test seam: forget the memoised directory. */
export function resetSpoolDirForTests(): void {
  spoolDir = undefined;
}

/**
 * multer options for the upload route: disk storage under the spool dir and a
 * hard byte limit. multer stops reading at the limit and raises
 * LIMIT_FILE_SIZE, which Nest reports as 413, so an oversized body never
 * fills the disk.
 */
export function spoolMulterOptions(maxBytes: number): MulterOptions {
  return {
    storage: diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadSpoolDir()),
      filename: (_req, _file, cb) => cb(null, `${randomUUID()}${SPOOL_SUFFIX}`),
    }),
    limits: { fileSize: maxBytes, files: 1 },
  };
}

/** Delete a spooled file; a file that is already gone is not an error. */
export async function removeSpooled(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/** Remove `.part` files older than `maxAgeMs`; returns how many were removed. */
export async function sweepSpool(
  maxAgeMs: number,
  dir: string = uploadSpoolDir(),
  now: number = Date.now(),
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(SPOOL_SUFFIX)) continue;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await unlink(full);
      removed++;
    } catch {
      // Another process may have removed it first; nothing to do.
    }
  }
  return removed;
}

/** Counts concurrent holders; `tryAcquire` never waits. */
export class Semaphore {
  private active = 0;

  constructor(readonly capacity: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.capacity) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }

  get inUse(): number {
    return this.active;
  }
}

/**
 * Refuses a request whose declared Content-Length already exceeds the upload
 * limit, before a single byte is spooled. Requests without the header pass;
 * multer's own limit still catches them.
 *
 * Used as an instance — `@UseGuards(new ContentLengthGuard(bytes))` — so the
 * limit is the same constant the route's multer options use.
 */
@Injectable()
export class ContentLengthGuard implements CanActivate {
  constructor(private readonly maxBytes: number) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const declared = Number(request?.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBytes + MULTIPART_OVERHEAD_BYTES) {
      const mb = Math.floor(this.maxBytes / (1024 * 1024));
      throw new PayloadTooLargeException(`File exceeds the upload limit of ${mb} MB`);
    }
    return true;
  }
}

/** Hourly: remove spool files a crashed request left behind. */
@Injectable()
export class UploadSpoolSweeper {
  private readonly logger = new Logger(UploadSpoolSweeper.name);

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    try {
      const removed = await sweepSpool(SPOOL_MAX_AGE_MS);
      if (removed > 0) this.logger.log(`Removed ${removed} orphaned upload spool file(s)`);
    } catch (err: any) {
      this.logger.warn(`Upload spool sweep failed: ${err?.message ?? err}`);
    }
  }
}
