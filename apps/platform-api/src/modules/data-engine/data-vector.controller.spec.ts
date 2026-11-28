import 'reflect-metadata';
import { HttpException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import {
  DocumentNotFoundError,
  EntityNotFoundError,
  VectorDimensionError,
  VectorScanLimitError,
  VectorSearchBusyError,
} from '@basefyio/data-engine';
import { DataVectorController } from './data-vector.controller';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { API_KEY_SCOPE_KEY } from '../../common/decorators/api-key-scope.decorator';
import { PLAN_GATE_KEY } from '../../common/decorators/plan-gate.decorator';
import { SetVectorConfigDto, SetVectorDto, SetVectorsDto, VectorSearchDto } from './dto/vector.dto';

const CONFIG = { mode: 'client' as const, dimensions: 3, updatedAt: '2026-11-28T00:00:00.000Z' };

function vectorCol(over: Record<string, jest.Mock> = {}) {
  return {
    setVector: jest.fn(async (id: string) => ({ id, dims: 3, model: 'client', source: 'client', updatedAt: 't', vector: [1, 0, 0] })),
    setVectors: jest.fn(async () => ({ written: ['a'], missing: ['b'] })),
    getVector: jest.fn(async (id: string) => ({ id, dims: 3, model: 'client', source: 'client', updatedAt: 't', vector: [1, 0, 0] })),
    deleteVector: jest.fn(async () => true),
    clearVectors: jest.fn(async () => 2),
    vectorSearch: jest.fn(async () => ({
      hits: [{ doc: { _id: 'a', title: 'x' }, distance: 0.1, score: 0.9 }],
      scanned: 5,
      strategy: 'exact',
    })),
    vectorStats: jest.fn(async () => ({ embedded: 0, total: 4 })),
    ...over,
  };
}

function build(col: Record<string, unknown>, opts: { config?: typeof CONFIG | null; collectionError?: unknown; available?: boolean } = {}) {
  const svc = {
    isAvailable: () => opts.available ?? true,
    getEntityCollection: jest.fn(async () => {
      if (opts.collectionError) throw opts.collectionError;
      return col;
    }),
    getVectorConfig: jest.fn(async () => (opts.config === undefined ? CONFIG : opts.config)),
    setVectorConfig: jest.fn(async () => undefined),
    getEngine: () => ({ capabilities: () => ({ vector: { strategy: 'exact', maxScan: 10000 } }) }),
  };
  return { ctrl: new DataVectorController(svc as any), svc };
}

const status = (err: any) => (err instanceof HttpException ? err.getStatus() : undefined);
const code = (err: any) => (err instanceof HttpException ? (err.getResponse() as any).code : undefined);

describe('DataVectorController access', () => {
  it('uses the record routes guard and the service key for every route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DataVectorController)).toEqual([JwtOrApiKeyGuard]);
    expect(Reflect.getMetadata(API_KEY_SCOPE_KEY, DataVectorController)).toBe('service');
    const proto = DataVectorController.prototype as any;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || Reflect.getMetadata(PATH_METADATA, proto[name]) === undefined) continue;
      // No handler carves itself out of the service-key default.
      expect(Reflect.getMetadata(API_KEY_SCOPE_KEY, proto[name])).toBeUndefined();
    }
  });

  it.each([
    ['setVectorConfig', RequestMethod.PUT, 'entities/:entity/vector-config', 'db_write'],
    ['getVectorConfig', RequestMethod.GET, 'entities/:entity/vector-config', undefined],
    ['deleteVectorConfig', RequestMethod.DELETE, 'entities/:entity/vector-config', undefined],
    ['vectorStatus', RequestMethod.GET, 'entities/:entity/vector-status', undefined],
    ['setVector', RequestMethod.PUT, 'data/:entity/:id/vector', 'db_write'],
    ['getVector', RequestMethod.GET, 'data/:entity/:id/vector', undefined],
    ['deleteVector', RequestMethod.DELETE, 'data/:entity/:id/vector', undefined],
    ['setVectors', RequestMethod.POST, 'data/:entity/vectors', 'db_write'],
    ['search', RequestMethod.POST, 'data/:entity/search', undefined],
  ])('%s is %s %s', (name, method, path, gate) => {
    const handler = (DataVectorController.prototype as any)[name];
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(PLAN_GATE_KEY, handler)).toBe(gate);
  });

  it('search and the batch write answer 200, a vector delete 204', () => {
    const proto = DataVectorController.prototype as any;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.search)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.setVectors)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.deleteVector)).toBe(204);
  });
});

describe('DataVectorController behaviour', () => {
  it('stores the vector config', async () => {
    const { ctrl, svc } = build(vectorCol(), { config: null });
    const out = await ctrl.setVectorConfig('p', 'docs', { mode: 'client', dimensions: 1536 });
    expect(out).toMatchObject({ mode: 'client', dimensions: 1536 });
    expect(svc.setVectorConfig).toHaveBeenCalledWith('p', 'docs', expect.objectContaining({ dimensions: 1536 }));
  });

  it('refuses a width change while vectors exist (409)', async () => {
    const col = vectorCol({ vectorStats: jest.fn(async () => ({ embedded: 3, total: 3 })) });
    const { ctrl } = build(col);
    const err = await ctrl.setVectorConfig('p', 'docs', { mode: 'client', dimensions: 4 }).catch((e) => e);
    expect(status(err)).toBe(409);
  });

  it('deleting a config with vectors needs ?purge=true, and then clears them', async () => {
    const col = vectorCol({ vectorStats: jest.fn(async () => ({ embedded: 2, total: 2 })) });
    const { ctrl, svc } = build(col);
    expect(status(await ctrl.deleteVectorConfig('p', 'docs').catch((e) => e))).toBe(409);
    expect(col.clearVectors).not.toHaveBeenCalled();
    expect(await ctrl.deleteVectorConfig('p', 'docs', 'true')).toEqual({ deleted: true, cleared: 2 });
    expect(svc.setVectorConfig).toHaveBeenCalledWith('p', 'docs', null);
  });

  it('a config that does not exist is 404', async () => {
    const { ctrl } = build(vectorCol(), { config: null });
    expect(status(await ctrl.getVectorConfig('p', 'docs').catch((e) => e))).toBe(404);
    expect(status(await ctrl.deleteVectorConfig('p', 'docs', 'true').catch((e) => e))).toBe(404);
  });

  it('writes and search without a vector config are 409 VECTOR_CONFIG_MISSING', async () => {
    const col = vectorCol();
    const { ctrl } = build(col, { config: null });
    for (const call of [
      () => ctrl.setVector('p', 'docs', 'a', { vector: [1, 0, 0] }),
      () => ctrl.setVectors('p', 'docs', { items: [{ id: 'a', vector: [1, 0, 0] }] }),
      () => ctrl.search('p', 'docs', { vector: [1, 0, 0] }),
    ]) {
      const err = await call().catch((e) => e);
      expect(status(err)).toBe(409);
      expect(code(err)).toBe('VECTOR_CONFIG_MISSING');
    }
    expect(col.setVector).not.toHaveBeenCalled();
    expect(col.vectorSearch).not.toHaveBeenCalled();
  });

  it('passes the configured width to the engine and maps its errors', async () => {
    const col = vectorCol({ setVector: jest.fn().mockRejectedValue(new VectorDimensionError('vector has 2 dimensions')) });
    const { ctrl } = build(col);
    const err = await ctrl.setVector('p', 'docs', 'a', { vector: [1, 0] }).catch((e) => e);
    expect(col.setVector).toHaveBeenCalledWith('a', [1, 0], { dimensions: 3 });
    expect(status(err)).toBe(400);
    expect(code(err)).toBe('VECTOR_DIMENSION_MISMATCH');
  });

  it('a record outside the project or entity is 404', async () => {
    const col = vectorCol({
      setVector: jest.fn().mockRejectedValue(new DocumentNotFoundError('docs', 'x')),
      getVector: jest.fn().mockRejectedValue(new DocumentNotFoundError('docs', 'x')),
    });
    const { ctrl } = build(col);
    expect(status(await ctrl.setVector('p', 'docs', 'x', { vector: [1, 0, 0] }).catch((e) => e))).toBe(404);
    expect(status(await ctrl.getVector('p', 'docs', 'x').catch((e) => e))).toBe(404);
  });

  it('a record without a vector is 404 on GET', async () => {
    const { ctrl } = build(vectorCol({ getVector: jest.fn(async () => null) }));
    expect(status(await ctrl.getVector('p', 'docs', 'a').catch((e) => e))).toBe(404);
  });

  it('search returns records with _distance and _score, the scan size and strategy', async () => {
    const col = vectorCol();
    const { ctrl } = build(col);
    const out = await ctrl.search('p', 'docs', { vector: [1, 0, 0], filter: { kind: 'faq' }, limit: 5 });
    expect(out).toEqual({ data: [{ _id: 'a', title: 'x', _distance: 0.1, _score: 0.9 }], scanned: 5, strategy: 'exact' });
    const q = (col.vectorSearch.mock.calls[0] as unknown[])[0] as any;
    expect(q).toMatchObject({ vector: [1, 0, 0], limit: 5, maxDistance: 0.5, dimensions: 3 });
    // The list filter grammar, compiled to the AST.
    expect(q.filter).toMatchObject({ type: 'field', operator: 'eq', value: 'faq' });
  });

  it.each([
    [new VectorScanLimitError(10001, 10000), 422, 'VECTOR_SCAN_LIMIT'],
    [new VectorSearchBusyError(), 429, 'VECTOR_SEARCH_BUSY'],
    [new VectorDimensionError('x'), 400, 'VECTOR_DIMENSION_MISMATCH'],
  ])('maps search error %p', async (error, httpStatus, errCode) => {
    const { ctrl } = build(vectorCol({ vectorSearch: jest.fn().mockRejectedValue(error) }));
    const err = await ctrl.search('p', 'docs', { vector: [1, 0, 0] }).catch((e) => e);
    expect(status(err)).toBe(httpStatus);
    expect(code(err)).toBe(errCode);
  });

  it('a malformed filter is a 400', async () => {
    const { ctrl } = build(vectorCol());
    const err = await ctrl.search('p', 'docs', { vector: [1, 0, 0], filter: { age: { $foo: 1 } } as any }).catch((e) => e);
    expect(status(err)).toBe(400);
  });

  it('a provider without vectors answers 501 VECTOR_NOT_SUPPORTED', async () => {
    const { ctrl } = build({ get: jest.fn() });
    for (const call of [
      () => ctrl.setVectorConfig('p', 'docs', { mode: 'client', dimensions: 3 }),
      () => ctrl.search('p', 'docs', { vector: [1, 0, 0] }),
      () => ctrl.vectorStatus('p', 'docs'),
    ]) {
      const err = await call().catch((e) => e);
      expect(status(err)).toBe(501);
      expect(code(err)).toBe('VECTOR_NOT_SUPPORTED');
    }
  });

  it('an unknown entity is 404 and an engine outage 503', async () => {
    const a = build(vectorCol(), { collectionError: new EntityNotFoundError('nope') });
    expect(status(await a.ctrl.vectorStatus('p', 'nope').catch((e) => e))).toBe(404);
    const b = build(vectorCol(), { available: false });
    expect(status(await b.ctrl.vectorStatus('p', 'docs').catch((e) => e))).toBe(503);
  });

  it('status reports mode, width, counts and the provider limits', async () => {
    const { ctrl } = build(vectorCol({ vectorStats: jest.fn(async () => ({ embedded: 2, total: 4 })) }));
    expect(await ctrl.vectorStatus('p', 'docs')).toEqual({
      mode: 'client', dimensions: 3, embedded: 2, total: 4, maxScan: 10000, strategy: 'exact',
    });
  });

  it('batch write returns written and missing ids', async () => {
    const { ctrl } = build(vectorCol());
    expect(await ctrl.setVectors('p', 'docs', { items: [{ id: 'a', vector: [1, 0, 0] }, { id: 'b', vector: [0, 1, 0] }] })).toEqual({
      written: ['a'],
      missing: ['b'],
    });
  });
});

describe('vector DTOs (global ValidationPipe settings)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (metatype: any, value: unknown) => pipe.transform(value, { type: 'body', metatype });

  it('accepts valid bodies', async () => {
    await expect(check(SetVectorConfigDto, { mode: 'client', dimensions: 1536 })).resolves.toBeDefined();
    await expect(check(SetVectorDto, { vector: [0.1, -2] })).resolves.toBeDefined();
    await expect(check(SetVectorsDto, { items: [{ id: 'a', vector: [1] }] })).resolves.toBeDefined();
    await expect(check(VectorSearchDto, { vector: [1], filter: { a: 1 }, limit: 100, threshold: 0 })).resolves.toBeDefined();
  });

  it.each([
    [SetVectorConfigDto, { mode: 'platform', dimensions: 3 }],
    [SetVectorConfigDto, { mode: 'client', dimensions: 2049 }],
    [SetVectorConfigDto, { mode: 'client', dimensions: 1.5 }],
    [SetVectorDto, { vector: [] }],
    [SetVectorDto, { vector: ['1'] }],
    [SetVectorDto, { vector: [1], extra: true }],
    [SetVectorsDto, { items: Array.from({ length: 101 }, (_, i) => ({ id: `i${i}`, vector: [1] })) }],
    [SetVectorsDto, { items: [{ vector: [1] }] }],
    [VectorSearchDto, { vector: [1], limit: 0 }],
    [VectorSearchDto, { vector: [1], limit: 101 }],
    [VectorSearchDto, { vector: [1], threshold: 2.1 }],
    [VectorSearchDto, { vector: [1], filter: 'a=1' }],
  ])('rejects %p %j', async (metatype, value) => {
    await expect(check(metatype, value)).rejects.toBeInstanceOf(HttpException);
  });
});
