import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { Observable } from 'rxjs';
import { SPOOL_SUFFIX, removeSpooled, uploadSpoolDir } from '../storage/upload-spool';

/** The shape the controllers read, matching what multer puts on `req.files`. */
export interface SpooledUpload {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
}

/** Text fields are small (`cacheControl`, `metadata`); anything bigger is not a field. */
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_FIELDS = 20;

/**
 * Reads a multipart upload the way storage-js sends it: the file under the
 * EMPTY field name, next to `cacheControl` and `metadata` text fields.
 *
 * multer cannot take it — busboy reports an unnamed part with no field name
 * and multer aborts with "Field name missing" — so this drives busboy (the
 * parser multer itself uses) directly, with the same spool-to-disk handling
 * as the dashboard's upload route: the first file goes to the upload spool,
 * capped at `maxBytes` (413 beyond), and the text fields land in `req.body`.
 *
 * A request that is not multipart passes through untouched; the handler then
 * streams the raw body.
 */
export async function parseMultipartUpload(req: Request, maxBytes: number): Promise<SpooledUpload[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const busboy = require('busboy') as (opts: Record<string, unknown>) => NodeJS.WritableStream & NodeJS.EventEmitter;
  const files: SpooledUpload[] = [];
  const fields: Record<string, string> = {};

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const pending: Array<Promise<void>> = [];
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      Promise.all(files.map((f) => removeSpooled(f.path).catch(() => undefined))).finally(() => reject(err));
    };
    const done = () => {
      if (settled) return;
      settled = true;
      Promise.all(pending).then(() => resolve(), fail);
    };

    let bb: NodeJS.WritableStream & NodeJS.EventEmitter;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { fileSize: maxBytes, files: 1, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES },
      });
    } catch (err: any) {
      reject(new BadRequestException(`Malformed multipart body: ${err?.message ?? err}`));
      return;
    }

    bb.on('field', (name: string, value: string) => {
      fields[name] = value;
    });

    bb.on('file', (name: string | undefined, stream: NodeJS.ReadableStream & { truncated?: boolean }, info: { filename?: string; mimeType?: string }) => {
      if (files.length > 0) {
        stream.resume();
        return;
      }
      const path = join(uploadSpoolDir(), `${randomUUID()}${SPOOL_SUFFIX}`);
      const entry: SpooledUpload = {
        fieldname: name ?? '',
        originalname: info?.filename || 'blob',
        mimetype: info?.mimeType || 'application/octet-stream',
        size: 0,
        path,
      };
      files.push(entry);
      const out = createWriteStream(path);
      pending.push(
        new Promise<void>((res, rej) => {
          out.once('close', res);
          out.once('error', rej);
        }),
      );
      stream.on('data', (chunk: Buffer) => {
        entry.size += chunk.length;
      });
      stream.once('limit', () => {
        stream.unpipe(out);
        out.destroy();
        const mb = Math.floor(maxBytes / (1024 * 1024));
        fail(new PayloadTooLargeException(`File exceeds the upload limit of ${mb} MB`));
      });
      stream.once('error', (err: Error) => fail(err));
      stream.pipe(out);
    });

    bb.once('error', (err: Error) => fail(new BadRequestException(`Malformed multipart body: ${err.message}`)));
    bb.once('filesLimit', () => undefined);
    bb.once('close', done);
    bb.once('finish', done);

    req.once('error', (err: Error) => fail(err));
    req.pipe(bb);
  });

  (req as any).files = files;
  req.body = { ...(typeof req.body === 'object' && req.body ? req.body : {}), ...fields };
  return files;
}

export function isMultipartRequest(req: Pick<Request, 'headers'>): boolean {
  const type = (req.headers['content-type'] as string | undefined) || '';
  return /^multipart\/form-data/i.test(type);
}

@Injectable()
export class StorageMultipartInterceptor implements NestInterceptor {
  constructor(private readonly maxBytes: number) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();
    if (isMultipartRequest(req)) {
      await parseMultipartUpload(req, this.maxBytes);
    }
    return next.handle();
  }
}
