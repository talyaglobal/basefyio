import { BadRequestException, HttpException } from '@nestjs/common';
import {
  ConcurrencyError,
  DocumentNotFoundError,
  DocumentTooLargeError,
  QueryValidationError,
  SchemaValidationError,
} from '@basefyio/data-engine';
import {
  etagFor,
  isExpectedError,
  parseIfMatch,
  parseListQuery,
  projectDocument,
  toDataEngineHttpError,
} from './data-engine-http.util';

function statusOf(err: unknown): number {
  return (toDataEngineHttpError(err) as HttpException).getStatus();
}

describe('toDataEngineHttpError', () => {
  it('maps engine errors to their HTTP status with message and code', () => {
    expect(statusOf(new QueryValidationError('bad filter'))).toBe(400);
    expect(statusOf(new DocumentNotFoundError('orders', 'x'))).toBe(404);
    expect(statusOf(new ConcurrencyError('orders', 'x', 1, 4))).toBe(409);
    expect(statusOf(new DocumentTooLargeError(1100, 1024))).toBe(413);
    expect(statusOf(new SchemaValidationError([{ path: 'age', message: 'must be a number' }]))).toBe(422);

    const res = toDataEngineHttpError(new ConcurrencyError('orders', 'x', 1, 4)).getResponse() as Record<string, unknown>;
    expect(res).toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
    expect(res.message).toContain('expected version 1, found 4');
  });

  it('never leaks internal error text', () => {
    const err = toDataEngineHttpError(new TypeError("Cannot read properties of undefined (reading 'replace')"));
    expect(err.getStatus()).toBe(500);
    expect(JSON.stringify(err.getResponse())).not.toContain('replace');
  });

  it('passes HTTP exceptions through', () => {
    const e = new BadRequestException('x');
    expect(toDataEngineHttpError(e)).toBe(e);
  });

  it('flags crashes (not client errors) for logging', () => {
    expect(isExpectedError(new QueryValidationError('x'))).toBe(true);
    expect(isExpectedError(new BadRequestException('x'))).toBe(true);
    expect(isExpectedError(new Error('boom'))).toBe(false);
  });
});

describe('parseIfMatch / etagFor', () => {
  it('accepts plain, quoted and weak versions', () => {
    expect(parseIfMatch('4')).toBe(4);
    expect(parseIfMatch('"4"')).toBe(4);
    expect(parseIfMatch('W/"4"')).toBe(4);
  });

  it('treats a missing header or * as "any version"', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('*')).toBeUndefined();
  });

  it('rejects anything else with 400', () => {
    expect(() => parseIfMatch('abc')).toThrow(BadRequestException);
  });

  it('builds the ETag from _version', () => {
    expect(etagFor({ _version: 4 })).toBe('"4"');
    expect(etagFor({})).toBeUndefined();
  });
});

describe('parseListQuery', () => {
  it('accepts the documented filter and sort formats', () => {
    const q = parseListQuery('orders', {
      filter: '{"grp":"g1"}',
      sort: '[{"path":"_createdAt","direction":"desc"}]',
    });
    expect(q.filter).toEqual({ type: 'field', path: { path: 'grp', isArrayPath: false }, operator: 'eq', value: 'g1' });
    expect(q.sort).toEqual([{ path: { path: '_createdAt', isArrayPath: false }, direction: 'desc' }]);
    expect(q.limit).toBe(50);
    expect(q.offset).toBe(0);
    expect(q.includeSoftDeleted).toBe(false);
  });

  it('keeps the AST format working', () => {
    const q = parseListQuery('orders', {
      filter: '{"type":"field","path":{"path":"grp"},"operator":"eq","value":"g1"}',
      sort: '[{"path":{"path":"_createdAt"},"direction":"desc"}]',
    });
    expect(q.filter).toMatchObject({ type: 'field', operator: 'eq', value: 'g1' });
    expect(q.sort?.[0].direction).toBe('desc');
  });

  it('validates limit, caps it at 1000 and honours the cursor', () => {
    expect(() => parseListQuery('o', { limit: '0' })).toThrow(/between 1 and 1000/);
    expect(() => parseListQuery('o', { limit: '-1' })).toThrow(/non-negative integer/);
    expect(() => parseListQuery('o', { limit: 'abc' })).toThrow(/non-negative integer/);
    expect(parseListQuery('o', { limit: '5000' }).limit).toBe(1000);
    expect(parseListQuery('o', { offset: '10', cursor: '50' }).offset).toBe(50);
  });

  it('reads includeSoftDeleted and select', () => {
    const q = parseListQuery('o', { includeSoftDeleted: 'true', select: 'name,address.city' });
    expect(q.includeSoftDeleted).toBe(true);
    expect(q.select?.map((s) => s.path)).toEqual(['name', 'address.city']);
  });

  it('rejects broken filter JSON as a client error', () => {
    expect(() => parseListQuery('o', { filter: '{"a":' })).toThrow(QueryValidationError);
  });
});

describe('projectDocument', () => {
  it('keeps the envelope and only the selected fields', () => {
    const doc = { _id: '1', _version: 2, name: 'n', secret: 's', address: { city: 'Ankara', zip: '06' } };
    expect(projectDocument(doc, [{ path: 'address.city', isArrayPath: false }])).toEqual({
      _id: '1',
      _version: 2,
      address: { city: 'Ankara' },
    });
  });
});
