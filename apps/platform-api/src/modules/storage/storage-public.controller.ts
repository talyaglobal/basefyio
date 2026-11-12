import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { StorageService } from './storage.service';
import { isActiveContentType } from './storage-objects';

/** How long a browser or CDN may keep a public file before asking again. */
const PUBLIC_CACHE_SECONDS = 300;

/** A single `bytes=a-b` / `bytes=a-` range within `size`, or null for none or one this route does not serve. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec((header || '').trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) return null;
  return { start, end };
}

/**
 * The file of a **public** bucket at a URL that needs no key at all — what
 * `getPublicUrl()` hands out, so it works in `<img src>`, `<video src>` and
 * plain links. Nothing here is more open than the bucket already is: a public
 * bucket's files are readable without credentials at the storage host, and any
 * other request (a private bucket, a missing project or file) is the same 404.
 *
 * No guard and no throttle, like the storage host itself; the lookups behind
 * it are cached per instance. Pages and other active content are sent as
 * attachments so they never render under the API's origin.
 */
@Controller('projects/:projectId/storage/public')
@SkipThrottle()
export class StoragePublicController {
  constructor(private readonly storage: StorageService) {}

  @Get(':bucketName')
  async getPublicObject(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('path') path: string | undefined,
    @Headers('range') rangeHeader: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { minioBucket, key, stat } = await this.storage.statPublicObject(projectId, bucketName, path ?? '');
    const etag = stat.etag ? `"${String(stat.etag).replace(/"/g, '')}"` : undefined;
    const contentType = String(stat.metaData?.['content-type'] || 'application/octet-stream');
    const fileName = encodeURIComponent(key.split('/').pop() || 'file');
    const disposition = isActiveContentType(contentType) ? 'attachment' : 'inline';

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `${disposition}; filename="${fileName}"; filename*=UTF-8''${fileName}`,
      'Cache-Control': `public, max-age=${PUBLIC_CACHE_SECONDS}`,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      ...(etag ? { ETag: etag } : {}),
      ...(stat.lastModified ? { 'Last-Modified': new Date(stat.lastModified).toUTCString() } : {}),
    });

    if (etag && ifNoneMatch && ifNoneMatch.split(',').some((t) => t.trim() === etag)) {
      res.status(304).end();
      return;
    }

    let range: { start: number; end: number } | undefined;
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, stat.size);
      if (!parsed) {
        res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      range = parsed;
      res.status(206).set({
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': String(range.end - range.start + 1),
      });
    } else {
      res.set('Content-Length', String(stat.size));
    }

    const stream = await this.storage.openObjectStream(minioBucket, key, range);
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  }
}
