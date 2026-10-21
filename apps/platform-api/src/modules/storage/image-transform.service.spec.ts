import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { PassThrough, Readable } from 'stream';

// A chainable stand-in for sharp: records every call, acts as a stream.
const calls: { name: string; args: unknown[] }[] = [];
let sharpAvailable = true;

function fakePipeline() {
  const pt = new PassThrough();
  for (const name of ['rotate', 'resize', 'toFormat']) {
    (pt as any)[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      return pt;
    };
  }
  return pt;
}

jest.mock(
  'sharp',
  () => {
    const factory: any = (opts: unknown) => {
      if (!sharpAvailable) throw new Error('binary missing');
      calls.push({ name: 'sharp', args: [opts] });
      return fakePipeline();
    };
    factory.concurrency = (n: number) => calls.push({ name: 'concurrency', args: [n] });
    factory.cache = (v: boolean) => calls.push({ name: 'cache', args: [v] });
    return factory;
  },
  { virtual: false },
);

import { ImageTransformService, hasTransformParams } from './image-transform.service';

function service(values: Record<string, unknown> = {}) {
  return new ImageTransformService({ get: (k: string) => values[k] } as any);
}

beforeEach(() => {
  calls.length = 0;
  sharpAvailable = true;
});

describe('limits', () => {
  it('uses the documented defaults when nothing is configured', () => {
    expect(service().limits).toEqual({
      maxDimension: 4096,
      maxSourceBytes: 25 * 1024 * 1024,
      maxPixels: 50_000_000,
      maxConcurrent: 4,
      cacheSeconds: 3600,
    });
  });

  it('reads overrides and ignores nonsense', () => {
    const s = service({
      'storage.transform.maxDimension': '2048',
      'storage.transform.maxSourceMb': 10,
      'storage.transform.maxConcurrent': 'abc',
      'storage.transform.cacheSeconds': 0,
    });
    expect(s.limits.maxDimension).toBe(2048);
    expect(s.limits.maxSourceBytes).toBe(10 * 1024 * 1024);
    expect(s.limits.maxConcurrent).toBe(4);
    expect(s.limits.cacheSeconds).toBe(0);
  });
});

describe('parseTransformQuery', () => {
  const s = service();

  it('refuses a request that would change nothing', () => {
    expect(() => s.parseTransformQuery({})).toThrow(BadRequestException);
    expect(() => s.parseTransformQuery({ quality: '80' })).toThrow(/at least one of width, height or format/);
  });

  it('rejects out-of-range or malformed values', () => {
    expect(() => s.parseTransformQuery({ width: '0' })).toThrow(/width must be an integer between 1 and 4096/);
    expect(() => s.parseTransformQuery({ width: '5000' })).toThrow(BadRequestException);
    expect(() => s.parseTransformQuery({ width: 'abc' })).toThrow(BadRequestException);
    expect(() => s.parseTransformQuery({ width: '10.5' })).toThrow(BadRequestException);
    expect(() => s.parseTransformQuery({ width: '10', quality: '101' })).toThrow(/quality/);
    expect(() => s.parseTransformQuery({ format: 'bmp' })).toThrow(/format must be one of jpeg, png, webp, avif/);
    expect(() => s.parseTransformQuery({ width: '10', fit: 'stretch' })).toThrow(/fit must be one of/);
  });

  it('returns only the options that were given, with jpg aliased to jpeg', () => {
    expect(s.parseTransformQuery({ width: '200', format: 'jpg', quality: '70', fit: 'inside' })).toEqual({
      width: 200,
      format: 'jpeg',
      quality: 70,
      fit: 'inside',
    });
    expect(s.parseTransformQuery({ height: 300 })).toEqual({ height: 300 });
  });

  it('drops fit when there is nothing to resize', () => {
    expect(s.parseTransformQuery({ format: 'webp', fit: 'cover' })).toEqual({ format: 'webp' });
  });
});

describe('hasTransformParams', () => {
  it('detects any known key and ignores others', () => {
    expect(hasTransformParams({ path: 'a.png' })).toBe(false);
    expect(hasTransformParams({ path: 'a.png', width: '10' })).toBe(true);
    expect(hasTransformParams({ format: '' })).toBe(false);
    expect(hasTransformParams(undefined)).toBe(false);
  });
});

describe('isTransformableSource / outputFormat', () => {
  const s = service();

  it('accepts the image types sharp decodes, within the size cap', () => {
    expect(s.isTransformableSource('image/png', 1024)).toEqual({ ok: true });
    expect(s.isTransformableSource('image/jpeg; charset=binary', 1024)).toEqual({ ok: true });
    expect(s.isTransformableSource('application/pdf', 1024)).toEqual({ ok: false, reason: 'type' });
    expect(s.isTransformableSource(undefined, 1024)).toEqual({ ok: false, reason: 'type' });
    expect(s.isTransformableSource('image/png', 30 * 1024 * 1024)).toEqual({ ok: false, reason: 'size' });
  });

  it('keeps the source format unless asked otherwise, and never writes gif/tiff', () => {
    expect(s.outputFormat('image/png', {})).toBe('png');
    expect(s.outputFormat('image/jpeg', {})).toBe('jpeg');
    expect(s.outputFormat('image/gif', {})).toBe('webp');
    expect(s.outputFormat('image/tiff', {})).toBe('webp');
    expect(s.outputFormat('image/png', { format: 'avif' })).toBe('avif');
    expect(s.contentTypeFor('webp')).toBe('image/webp');
  });
});

describe('etagFor', () => {
  const s = service();

  it('is stable for the same input and changes with the object or any option', () => {
    const a = s.etagFor('"abc"', { width: 200, format: 'webp' });
    expect(a).toBe(s.etagFor('abc', { format: 'webp', width: 200 }));
    expect(a).toMatch(/^W\/"abc-[0-9a-f]{16}"$/);
    expect(a).not.toBe(s.etagFor('abd', { width: 200, format: 'webp' }));
    expect(a).not.toBe(s.etagFor('abc', { width: 201, format: 'webp' }));
    expect(a).not.toBe(s.etagFor('abc', { width: 200, format: 'webp', quality: 50 }));
  });
});

describe('transform pipeline', () => {
  it('builds the sharp pipeline with the documented options and streams through it', async () => {
    const s = service();
    const source = Readable.from([Buffer.from('png-bytes')]);

    const { stream, contentType, format } = s.transform(source, 'image/png', { width: 200, format: 'webp', quality: 80 });

    expect(contentType).toBe('image/webp');
    expect(format).toBe('webp');
    expect(calls.find((c) => c.name === 'concurrency')?.args).toEqual([1]);
    expect(calls.find((c) => c.name === 'cache')?.args).toEqual([false]);
    expect(calls.find((c) => c.name === 'sharp')?.args[0]).toMatchObject({
      limitInputPixels: 50_000_000,
      failOn: 'error',
      animated: false,
    });
    expect(calls.find((c) => c.name === 'rotate')).toBeTruthy();
    expect(calls.find((c) => c.name === 'resize')?.args[0]).toEqual({
      width: 200,
      height: undefined,
      fit: 'cover',
      withoutEnlargement: true,
    });
    expect(calls.find((c) => c.name === 'toFormat')?.args).toEqual(['webp', { quality: 80 }]);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('png-bytes');
  });

  it('skips resize when only a format change is requested and defaults quality to 80', () => {
    const s = service();
    s.transform(Readable.from([]), 'image/jpeg', { format: 'avif' });
    expect(calls.find((c) => c.name === 'resize')).toBeUndefined();
    expect(calls.find((c) => c.name === 'toFormat')?.args).toEqual(['avif', { quality: 80 }]);
  });

  it('reports unavailability and answers 501 when the native module cannot load', () => {
    sharpAvailable = false;
    const s = service();
    // The factory throws on first use; the service must treat that as "not available".
    expect(() => s.transform(Readable.from([]), 'image/png', { width: 10 })).toThrow();
    sharpAvailable = true;
  });
});

describe('concurrency slots', () => {
  it('hands out at most maxConcurrent slots and releases idempotently', () => {
    const s = service({ 'storage.transform.maxConcurrent': 2 });
    const a = s.tryAcquire();
    const b = s.tryAcquire();
    expect(a && b).toBeTruthy();
    expect(s.tryAcquire()).toBeNull();
    expect(s.activeTransforms).toBe(2);
    a!();
    a!();
    expect(s.activeTransforms).toBe(1);
    expect(s.tryAcquire()).not.toBeNull();
  });
});

describe('available()', () => {
  it('is false when require("sharp") throws, and transform answers 501', () => {
    const spy = jest
      .spyOn(ImageTransformService.prototype as any, 'requireSharp')
      .mockImplementation(() => {
        throw new Error('no binary');
      });
    try {
      const s = service();
      expect(s.available()).toBe(false);
      // The failure is remembered; the module is not re-required on every call.
      expect(s.available()).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(() => s.transform(Readable.from([]), 'image/png', { width: 10 })).toThrow(NotImplementedException);
    } finally {
      spy.mockRestore();
    }
  });

  it('is true on a build where the module loads', () => {
    expect(service().available()).toBe(true);
  });
});
