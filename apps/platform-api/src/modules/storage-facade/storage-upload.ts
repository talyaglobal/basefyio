import type { Request } from 'express';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { removeSpooled } from '../storage/upload-spool';
import { StorageFacadeError } from './storage-facade.errors';
import { cacheControlHeader, decodeUserMetadata } from './storage-facade.util';
import type { UploadInput } from './storage-facade.service';
import type { SpooledUpload } from './storage-multipart.interceptor';

/**
 * The body of an upload request, in either of the two forms storage-js
 * sends: multipart (the file under the empty field name, plus `cacheControl`
 * and `metadata` text fields) which StorageMultipartInterceptor spooled to disk, or
 * the raw bytes with `content-type`, `cache-control` and `x-metadata`
 * headers.
 *
 * A raw body the global JSON parser already consumed (a JSON file uploaded
 * with `content-type: application/json` before main.ts learned to skip these
 * routes) is recovered from `req.rawBody`, which Nest keeps when the app is
 * created with `rawBody: true`.
 */
export function uploadInputFrom(
  req: Request,
  files: SpooledUpload[] | undefined,
): { input: UploadInput; cleanup: () => Promise<void> } {
  const file = files?.[0];
  if (file) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return {
      input: {
        body: createReadStream(file.path),
        size: file.size,
        contentType: file.mimetype || 'application/octet-stream',
        cacheControl: cacheControlHeader(body.cacheControl),
        userMetadata: decodeUserMetadata(body.metadata),
      },
      cleanup: () => removeSpooled(file.path),
    };
  }

  const contentType = (req.headers['content-type'] as string | undefined) || 'application/octet-stream';
  const cacheControl = cacheControlHeader(req.headers['cache-control']);
  const userMetadata = decodeUserMetadata(req.headers['x-metadata'], true);
  const declared = Number(req.headers['content-length']);
  const size = Number.isFinite(declared) && declared >= 0 ? declared : undefined;

  if (req.readableEnded || (req as any).complete === true) {
    const raw = (req as any).rawBody;
    if (Buffer.isBuffer(raw)) {
      return { input: { body: raw, size: raw.length, contentType, cacheControl, userMetadata }, cleanup: async () => undefined };
    }
    if (Buffer.isBuffer(req.body)) {
      const buf = req.body as Buffer;
      return { input: { body: buf, size: buf.length, contentType, cacheControl, userMetadata }, cleanup: async () => undefined };
    }
    throw StorageFacadeError.invalid(
      'The upload body was consumed by a body parser before it reached storage; see isJsonBody in main.ts',
    );
  }

  return {
    input: { body: req as unknown as Readable, size, contentType, cacheControl, userMetadata },
    cleanup: async () => undefined,
  };
}
