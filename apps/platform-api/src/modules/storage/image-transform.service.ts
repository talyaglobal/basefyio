import { BadRequestException, Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Readable } from 'stream';

export type ImageOutputFormat = 'jpeg' | 'png' | 'webp' | 'avif';
export type ImageFit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';

export interface ImageTransformOptions {
  width?: number;
  height?: number;
  format?: ImageOutputFormat;
  quality?: number;
  fit?: ImageFit;
}

export interface ImageTransformLimits {
  /** Largest accepted `width` or `height`. */
  maxDimension: number;
  /** Largest source object that will be decoded. */
  maxSourceBytes: number;
  /** sharp's `limitInputPixels`: refuses images with more pixels than this. */
  maxPixels: number;
  /** Transforms running at once on this instance; beyond it the route answers 503. */
  maxConcurrent: number;
  /** `Cache-Control: max-age` on render responses. */
  cacheSeconds: number;
}

const OUTPUT_FORMATS: readonly ImageOutputFormat[] = ['jpeg', 'png', 'webp', 'avif'];
const FITS: readonly ImageFit[] = ['cover', 'contain', 'fill', 'inside', 'outside'];

/** Source content types sharp decodes without extra system libraries. */
const TRANSFORMABLE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/tiff',
]);

const FORMAT_BY_SOURCE_TYPE: Record<string, ImageOutputFormat> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

const CONTENT_TYPE_BY_FORMAT: Record<ImageOutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** Query keys the render route understands. Anything else on the URL is ignored. */
export const TRANSFORM_QUERY_KEYS = ['width', 'height', 'format', 'quality', 'fit'] as const;

export function hasTransformParams(query: Record<string, unknown> | undefined): boolean {
  if (!query) return false;
  return TRANSFORM_QUERY_KEYS.some((k) => query[k] !== undefined && query[k] !== '');
}

function positiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nonNegativeInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Resizes and re-encodes images on the way out of storage.
 *
 * sharp is loaded on first use rather than at import time: a build without the
 * native binary still boots and serves every other storage route, and the
 * render route answers 501 instead of taking the API down. libvips runs with a
 * single thread and no pixel cache because the host is shared with the
 * database, the identity provider and the object store.
 */
@Injectable()
export class ImageTransformService {
  private readonly logger = new Logger(ImageTransformService.name);
  readonly limits: ImageTransformLimits;
  /** `undefined` = not attempted yet, `null` = unavailable on this build. */
  private sharpModule: any | null | undefined;
  private inFlight = 0;

  constructor(private readonly config: ConfigService) {
    this.limits = {
      maxDimension: positiveInt(config.get('storage.transform.maxDimension'), 4096),
      maxSourceBytes: positiveInt(config.get('storage.transform.maxSourceMb'), 25) * 1024 * 1024,
      maxPixels: positiveInt(config.get('storage.transform.maxPixels'), 50_000_000),
      maxConcurrent: positiveInt(config.get('storage.transform.maxConcurrent'), 4),
      cacheSeconds: nonNegativeInt(config.get('storage.transform.cacheSeconds'), 3600),
    };
  }

  /** Whether the native image library could be loaded on this build. */
  available(): boolean {
    return this.loadSharp() !== null;
  }

  /** The one place the native module is required; overridable so tests can simulate a build without it. */
  protected requireSharp(): unknown {
    // Loaded lazily on purpose — see the class comment.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('sharp');
  }

  private loadSharp(): any | null {
    if (this.sharpModule !== undefined) return this.sharpModule;
    try {
      const mod: any = this.requireSharp();
      const sharp = mod?.default ?? mod;
      if (typeof sharp !== 'function') throw new Error('sharp did not export a factory');
      if (typeof sharp.concurrency === 'function') sharp.concurrency(1);
      if (typeof sharp.cache === 'function') sharp.cache(false);
      this.sharpModule = sharp;
    } catch (err: any) {
      this.logger.warn(
        `sharp is not loadable on this build; image transforms are disabled: ${err?.message ?? err}`,
      );
      this.sharpModule = null;
    }
    return this.sharpModule;
  }

  /**
   * Validates the render query. Throws 400 for anything out of range; requires
   * at least one of width, height or format so a request that would change
   * nothing is refused instead of re-encoding for no reason.
   */
  parseTransformQuery(query: Record<string, unknown>): ImageTransformOptions {
    const width = this.intParam(query.width, 'width', 1, this.limits.maxDimension);
    const height = this.intParam(query.height, 'height', 1, this.limits.maxDimension);
    const quality = this.intParam(query.quality, 'quality', 1, 100);

    let format: ImageOutputFormat | undefined;
    if (query.format !== undefined && query.format !== '') {
      const raw = String(query.format).toLowerCase();
      const mapped = raw === 'jpg' ? 'jpeg' : raw;
      if (!OUTPUT_FORMATS.includes(mapped as ImageOutputFormat)) {
        throw new BadRequestException(`format must be one of ${OUTPUT_FORMATS.join(', ')}`);
      }
      format = mapped as ImageOutputFormat;
    }

    let fit: ImageFit | undefined;
    if (query.fit !== undefined && query.fit !== '') {
      const raw = String(query.fit).toLowerCase();
      if (!FITS.includes(raw as ImageFit)) {
        throw new BadRequestException(`fit must be one of ${FITS.join(', ')}`);
      }
      fit = raw as ImageFit;
    }

    if (width === undefined && height === undefined && format === undefined) {
      throw new BadRequestException('Specify at least one of width, height or format');
    }

    const opts: ImageTransformOptions = {};
    if (width !== undefined) opts.width = width;
    if (height !== undefined) opts.height = height;
    if (format !== undefined) opts.format = format;
    if (quality !== undefined) opts.quality = quality;
    if (fit !== undefined && (width !== undefined || height !== undefined)) opts.fit = fit;
    return opts;
  }

  private intParam(raw: unknown, name: string, min: number, max: number): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
    }
    return n;
  }

  isTransformableSource(
    contentType: string | undefined,
    size: number,
  ): { ok: true } | { ok: false; reason: 'type' | 'size' } {
    const type = (contentType || '').split(';')[0].trim().toLowerCase();
    if (!TRANSFORMABLE_TYPES.has(type)) return { ok: false, reason: 'type' };
    if (size > this.limits.maxSourceBytes) return { ok: false, reason: 'size' };
    return { ok: true };
  }

  /** The requested format, else the source's own, else webp for formats we never write (gif, tiff). */
  outputFormat(sourceContentType: string | undefined, opts: ImageTransformOptions): ImageOutputFormat {
    if (opts.format) return opts.format;
    const type = (sourceContentType || '').split(';')[0].trim().toLowerCase();
    return FORMAT_BY_SOURCE_TYPE[type] ?? 'webp';
  }

  contentTypeFor(format: ImageOutputFormat): string {
    return CONTENT_TYPE_BY_FORMAT[format];
  }

  /** Weak ETag derived from the source's ETag and the canonical option set, so a changed object or option invalidates it. */
  etagFor(sourceEtag: string | undefined, opts: ImageTransformOptions): string {
    const canonical = TRANSFORM_QUERY_KEYS.filter((k) => opts[k] !== undefined)
      .map((k) => `${k}=${String(opts[k])}`)
      .join('&');
    const digest = createHash('sha1').update(canonical).digest('hex').slice(0, 16);
    const source = (sourceEtag || 'none').replace(/"/g, '');
    return `W/"${source}-${digest}"`;
  }

  /** Reserve one of the concurrent transform slots; `null` when all are busy. The returned release is idempotent. */
  tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.limits.maxConcurrent) return null;
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
    };
  }

  get activeTransforms(): number {
    return this.inFlight;
  }

  /**
   * Builds the streaming pipeline. Nothing is buffered: the source stream is
   * piped through sharp and the result is piped to the response by the caller.
   */
  transform(
    source: Readable,
    sourceContentType: string | undefined,
    opts: ImageTransformOptions,
  ): { stream: Readable; contentType: string; format: ImageOutputFormat } {
    const sharp = this.loadSharp();
    if (!sharp) throw new NotImplementedException('Image transforms are not available on this build');

    const format = this.outputFormat(sourceContentType, opts);
    let pipeline = sharp({
      limitInputPixels: this.limits.maxPixels,
      failOn: 'error',
      animated: false,
      sequentialRead: true,
    }).rotate();

    if (opts.width !== undefined || opts.height !== undefined) {
      pipeline = pipeline.resize({
        width: opts.width,
        height: opts.height,
        fit: opts.fit ?? 'cover',
        withoutEnlargement: true,
      });
    }

    pipeline = pipeline.toFormat(format, { quality: opts.quality ?? 80 });

    source.on('error', (err: Error) => pipeline.destroy(err));
    return { stream: source.pipe(pipeline), contentType: this.contentTypeFor(format), format };
  }
}
