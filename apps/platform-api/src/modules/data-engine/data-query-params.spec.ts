import { BadRequestException } from '@nestjs/common';
import { parseFilterParam, parseSortParam } from './data-query-params';

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
