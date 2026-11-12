import {
  isFilterAst,
  normalizeFilterInput,
  normalizeSelectInput,
  normalizeSortInput,
} from '../query/request-input';
import { QueryValidationError } from '../interfaces/data-engine';

describe('normalizeFilterInput', () => {
  it('accepts the documented document format (plain equality)', () => {
    expect(normalizeFilterInput('{"grp":"g1"}')).toEqual({
      type: 'field',
      path: { path: 'grp', isArrayPath: false },
      operator: 'eq',
      value: 'g1',
    });
  });

  it('accepts nested dotted paths and operators', () => {
    const f = normalizeFilterInput({ 'address.city': 'Istanbul', total: { $gte: 10 } });
    expect(f).toEqual({
      type: 'and',
      conditions: [
        { type: 'field', path: { path: 'address.city', isArrayPath: false }, operator: 'eq', value: 'Istanbul' },
        { type: 'field', path: { path: 'total', isArrayPath: false }, operator: 'gte', value: 10 },
      ],
    });
  });

  it('accepts $or / $and / $not', () => {
    const f = normalizeFilterInput({ $or: [{ a: 1 }, { b: { $in: [1, 2] } }] });
    expect(f?.type).toBe('or');
  });

  it('keeps the Filter AST format working (object path)', () => {
    const ast = { type: 'field', path: { path: 'grp' }, operator: 'eq', value: 'g1' };
    expect(normalizeFilterInput(JSON.stringify(ast))).toEqual({
      type: 'field',
      path: { path: 'grp', isArrayPath: false },
      operator: 'eq',
      value: 'g1',
    });
  });

  it('accepts the AST with a string path and logical nodes', () => {
    const f = normalizeFilterInput({
      type: 'or',
      conditions: [
        { type: 'field', path: 'grp', operator: 'eq', value: 'g1' },
        { type: 'not', condition: { type: 'field', path: 'n', operator: 'exists' } },
      ],
    });
    expect(f).toEqual({
      type: 'or',
      conditions: [
        { type: 'field', path: { path: 'grp', isArrayPath: false }, operator: 'eq', value: 'g1' },
        { type: 'not', condition: { type: 'field', path: { path: 'n', isArrayPath: false }, operator: 'exists', value: true } },
      ],
    });
  });

  it('treats a user field named "type" as a document filter', () => {
    expect(isFilterAst({ type: 'and' })).toBe(false);
    expect(normalizeFilterInput({ type: 'and' })).toEqual({
      type: 'field',
      path: { path: 'type', isArrayPath: false },
      operator: 'eq',
      value: 'and',
    });
  });

  it('treats empty input as match-everything', () => {
    expect(normalizeFilterInput(undefined)).toBeUndefined();
    expect(normalizeFilterInput('')).toBeUndefined();
    expect(normalizeFilterInput('{}')).toBeUndefined();
  });

  it.each([
    ['broken JSON', '{"a":', /not valid JSON/],
    ['an array', '[1,2]', /must be a JSON object/],
    ['an empty AST "and"', { type: 'and', conditions: [] }, /at least one condition/],
    ['an unknown AST operator', { type: 'field', path: 'a', operator: 'between', value: 1 }, /unknown filter operator/],
    ['an unsafe AST path', { type: 'field', path: "a') OR 1=1 --", operator: 'eq', value: 1 }, /invalid field path/],
    ['$ keys inside an AST value', { type: 'field', path: 'a', operator: 'eq', value: { $where: 'x' } }, /not allowed/],
    ['an in without array', { type: 'field', path: 'a', operator: 'in', value: 1 }, /requires an array/],
    ['an unknown document operator', { a: { $between: [1, 2] } }, /unknown operator/],
    ['an invalid regex', { a: { $regex: '(' } }, /invalid regular expression/],
  ])('rejects %s with a QueryValidationError', (_label, input, message) => {
    expect(() => normalizeFilterInput(input)).toThrow(QueryValidationError);
    expect(() => normalizeFilterInput(input)).toThrow(message);
  });
});

describe('normalizeSortInput', () => {
  const desc = (path: string) => ({ path: { path, isArrayPath: false }, direction: 'desc' });
  const asc = (path: string) => ({ path: { path, isArrayPath: false }, direction: 'asc' });

  it('accepts the SDK / docs format', () => {
    expect(normalizeSortInput('[{"path":"_createdAt","direction":"desc"}]')).toEqual([desc('_createdAt')]);
  });

  it('keeps the AST format working', () => {
    expect(normalizeSortInput([{ path: { path: '_createdAt' }, direction: 'desc' }])).toEqual([desc('_createdAt')]);
  });

  it('accepts a single clause object', () => {
    expect(normalizeSortInput({ path: 'createdAt', direction: 'desc' })).toEqual([desc('createdAt')]);
  });

  it('accepts the document format and treats a field named "path" correctly', () => {
    expect(normalizeSortInput({ name: 1, age: -1 })).toEqual([asc('name'), desc('age')]);
    expect(normalizeSortInput({ path: -1 })).toEqual([desc('path')]);
  });

  it('accepts a plain comma-separated string', () => {
    expect(normalizeSortInput('-_createdAt,name')).toEqual([desc('_createdAt'), asc('name')]);
  });

  it('defaults a missing direction to asc', () => {
    expect(normalizeSortInput([{ path: 'name' }])).toEqual([asc('name')]);
  });

  it('rejects an invalid direction instead of silently sorting asc', () => {
    expect(() => normalizeSortInput([{ path: 'name', direction: 'sideways' }])).toThrow(/invalid sort direction/);
  });

  it('rejects broken JSON, unsafe paths and too many fields', () => {
    expect(() => normalizeSortInput('[{"path":')).toThrow(/not valid JSON/);
    expect(() => normalizeSortInput([{ path: 'a;drop' }])).toThrow(/invalid field path/);
    expect(() => normalizeSortInput('a,b,c,d,e,f')).toThrow(/at most 5/);
  });
});

describe('normalizeSelectInput', () => {
  it('accepts comma lists, arrays and inclusion objects', () => {
    const expected = [
      { path: 'name', isArrayPath: false },
      { path: 'address.city', isArrayPath: false },
    ];
    expect(normalizeSelectInput('name,address.city')).toEqual(expected);
    expect(normalizeSelectInput('["name","address.city"]')).toEqual(expected);
    expect(normalizeSelectInput({ name: 1, 'address.city': 1, other: 0 })).toEqual(expected);
  });

  it('rejects unsafe paths', () => {
    expect(() => normalizeSelectInput('name,$where()')).toThrow(QueryValidationError);
  });
});
