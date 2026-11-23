import { BadRequestException, ConflictException, HttpException, NotImplementedException } from '@nestjs/common';
import { DocumentNotFoundError, ConcurrencyError, EntityNotFoundError } from '@basefyio/data-engine';
import { DataEngineController, parseIfMatch, toHttpError } from './data-engine.controller';

/** #173: engine errors keep their status, If-Match reaches the engine, deleted documents can be restored. */
function build(col: Record<string, jest.Mock | undefined>, opts: { collectionError?: unknown } = {}) {
  const svc = {
    isAvailable: () => true,
    getEntityCollection: jest.fn(async () => {
      if (opts.collectionError) throw opts.collectionError;
      return col;
    }),
    getEntityDefinition: jest.fn(async () => ({ fields: [] })),
  };
  const ctrl = new DataEngineController(svc as any);
  const res = { setHeader: jest.fn() } as any;
  return { ctrl, res, svc };
}

describe('DataEngineController (#173)', () => {
  it('maps a missing document to 404, not 500', async () => {
    const { ctrl } = build({ delete: jest.fn().mockRejectedValue(new DocumentNotFoundError('note', 'x')) });
    const err: any = await ctrl.deleteRecord('p', 'note', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(404);
  });

  it('passes If-Match to the engine and answers a stale version with 409', async () => {
    const update = jest.fn().mockRejectedValue(new ConcurrencyError('note', 'x', 1, 4));
    const { ctrl, res } = build({ update });
    const err: any = await ctrl.updateRecord('p', 'note', 'x', { a: 1 }, res, '"1"').catch((e) => e);
    expect(update).toHaveBeenCalledWith('x', { a: 1 }, { userId: undefined, ifMatch: 1 });
    expect(err.getStatus()).toBe(409);
  });

  it('sets ETag from the document version', async () => {
    const { ctrl, res } = build({ update: jest.fn().mockResolvedValue({ _id: 'x', _version: 5 }) });
    await ctrl.updateRecord('p', 'note', 'x', { a: 1 }, res, undefined);
    expect(res.setHeader).toHaveBeenCalledWith('ETag', '"5"');
  });

  it('restores a soft-deleted document, and says so when the provider cannot', async () => {
    const restore = jest.fn().mockResolvedValue({ _id: 'x', _version: 3 });
    const a = build({ restore });
    expect(await a.ctrl.restoreRecord('p', 'note', 'x', a.res)).toEqual({ _id: 'x', _version: 3 });
    const b = build({ restore: undefined });
    await expect(b.ctrl.restoreRecord('p', 'note', 'x', b.res)).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('lists soft-deleted documents only when asked', async () => {
    const query = jest.fn().mockResolvedValue({ data: [] });
    const { ctrl } = build({ query });
    await ctrl.listRecords('p', 'note', undefined, undefined, undefined, undefined, 'true');
    expect(query.mock.calls[0][0].includeSoftDeleted).toBe(true);
    await ctrl.listRecords('p', 'note');
    expect(query.mock.calls[1][0].includeSoftDeleted).toBe(false);
  });

  it('a driver error in a query is a 400 without its internals', async () => {
    const { ctrl } = build({ query: jest.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'x')")) });
    const err: any = await ctrl.listRecords('p', 'note').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).not.toContain('Cannot read');
  });

  it('an unknown entity is 404, not 503', async () => {
    const { ctrl } = build({}, { collectionError: new EntityNotFoundError('nope') });
    const err: any = await ctrl.listRecords('p', 'nope').catch((e) => e);
    expect(err.getStatus()).toBe(404);
  });
});

describe('DataEngineController.listEntities counts (#176)', () => {
  it('adds document counts only when asked, and a failing count is null', async () => {
    const svc = {
      isAvailable: () => true,
      listEntities: jest.fn(async () => [{ logicalName: 'a' }, { logicalName: 'b' }]),
      getEntityCollection: jest.fn(async (_p: string, e: string) => ({
        count: e === 'a' ? jest.fn(async () => 7) : jest.fn(async () => { throw new Error('down'); }),
      })),
    };
    const ctrl = new DataEngineController(svc as any);
    expect(await ctrl.listEntities('p')).toEqual([{ logicalName: 'a' }, { logicalName: 'b' }]);
    expect(svc.getEntityCollection).not.toHaveBeenCalled();
    expect(await ctrl.listEntities('p', 'true')).toEqual([
      { logicalName: 'a', documentCount: 7 },
      { logicalName: 'b', documentCount: null },
    ]);
  });
});

describe('parseIfMatch / toHttpError', () => {
  it('reads plain, quoted and weak versions', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('3')).toBe(3);
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch('W/"3"')).toBe(3);
    expect(() => parseIfMatch('abc')).toThrow(BadRequestException);
  });

  it('leaves Nest exceptions alone', () => {
    const e = new ConflictException('x');
    expect(toHttpError(e)).toBe(e);
  });
});
