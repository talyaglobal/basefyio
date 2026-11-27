import { BadRequestException } from '@nestjs/common';
import { parseFilterParam, parsePagingParams, parseSortParam } from './data-query-params';

describe('data query params', () => {
  it('compiles the plain-object filter', () => {
    expect(parseFilterParam('{"grp":"g1"}')).toMatchObject({ type: 'field', operator: 'eq', value: 'g1' });
  });
  it('passes the AST format through', () => {
    const ast = { type: 'field', path: { path: 'grp' }, operator: 'eq', value: 'g1' };
    expect(parseFilterParam(JSON.stringify(ast))).toEqual(ast);
  });
  it('rejects bad filters with 400', () => {
    expect(() => parseFilterParam('{nope')).toThrow(BadRequestException);
    expect(() => parseFilterParam('{"a":{"$bad":1}}')).toThrow(BadRequestException);
  });
  it('accepts SDK sort array and object sort', () => {
    expect(parseSortParam('[{"path":"_createdAt","direction":"desc"}]')).toEqual([
      { path: { path: '_createdAt', isArrayPath: false }, direction: 'desc' },
    ]);
    expect(parseSortParam('{"a":-1}')).toEqual([{ path: { path: 'a', isArrayPath: false }, direction: 'desc' }]);
  });
  it('rejects invalid sort direction', () => {
    expect(() => parseSortParam('[{"path":"a","direction":"up"}]')).toThrow(BadRequestException);
  });
});

describe('paging params', () => {
  it('passes through nothing, plain numbers and a cursor', () => {
    expect(parsePagingParams()).toEqual({ limit: undefined, offset: undefined });
    expect(parsePagingParams('25', '50')).toEqual({ limit: 25, offset: 50 });
    expect(parsePagingParams('25', undefined, '75')).toEqual({ limit: 25, offset: 75 });
  });
  it.each([['0'], ['-1'], ['abc'], ['1.5'], ['1001']])('rejects limit=%s with 400', (v) => {
    expect(() => parsePagingParams(v)).toThrow(BadRequestException);
  });
  it('rejects a bad offset or cursor and both together', () => {
    expect(() => parsePagingParams(undefined, '-3')).toThrow(BadRequestException);
    expect(() => parsePagingParams(undefined, undefined, 'x')).toThrow(BadRequestException);
    expect(() => parsePagingParams(undefined, '1', '2')).toThrow(BadRequestException);
  });
});
