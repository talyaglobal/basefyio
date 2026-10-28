import { FunctionMeta, callShape, chooseOverload, inputNames } from './rpc';

const fn = (over: Partial<FunctionMeta>): FunctionMeta => ({
  signature: 'f()',
  definer: false,
  argnames: [],
  argmodes: [],
  ...over,
});

describe('inputNames', () => {
  it('takes every name when no modes are recorded', () => {
    expect(inputNames(fn({ argnames: ['a', 'b'] }))).toEqual(['a', 'b']);
  });

  it('drops OUT and TABLE columns, keeps IN, INOUT and VARIADIC', () => {
    expect(
      inputNames(fn({ argnames: ['a', 'b', 'c', 'd', 'e'], argmodes: ['i', 'o', 'b', 'v', 't'] })),
    ).toEqual(['a', 'c', 'd']);
  });
});

describe('chooseOverload', () => {
  const byName = fn({ signature: 'f(a integer, b text)', argnames: ['a', 'b'], argtypes: ['integer', 'text'] });
  const byOne = fn({ signature: 'f(a integer)', argnames: ['a'], argtypes: ['integer'] });
  const withDefault = fn({ signature: 'f(a integer, b text DEFAULT)', argnames: ['a', 'b'], pronargdefaults: 1 });

  it('picks the overload whose inputs exactly cover the keys sent', () => {
    expect(chooseOverload([byName, byOne], ['a'], { strict: true })?.meta).toBe(byOne);
    expect(chooseOverload([byName, byOne], ['b', 'a'], { strict: true })?.meta).toBe(byName);
  });

  it('accepts a missing parameter that has a default, never one that does not', () => {
    expect(chooseOverload([withDefault], ['a'], { strict: true })?.meta).toBe(withDefault);
    expect(chooseOverload([byName], ['a'], { strict: true })).toBeNull();
  });

  it('is strict about unknown keys for a PostgREST caller and lenient for the SDKs', () => {
    expect(chooseOverload([byOne], ['a', 'zzz'], { strict: true })).toBeNull();
    expect(chooseOverload([byOne], ['a', 'zzz'], { strict: false })?.meta).toBe(byOne);
    // The lenient rule is what the SDK always had: keys the function does
    // not name are ignored, not refused.
    expect(chooseOverload([fn({ argnames: [] })], ['ignored'])?.inputs).toEqual([]);
  });

  it('routes Prefer: params=single-object to the overload with one JSON parameter', () => {
    const json = fn({ signature: 'f(payload jsonb)', argnames: ['payload'], argtypes: ['jsonb'] });
    const chosen = chooseOverload([byName, json], ['anything', 'goes'], { singleObject: true });
    expect(chosen?.meta).toBe(json);
    expect(chosen?.singleJson).toBe(true);
    expect(chosen?.jsonType).toBe('jsonb');
    expect(chooseOverload([byName], ['a'], { singleObject: true })).toBeNull();
  });

  it('treats a single unnamed JSON parameter as the whole body, as PostgREST 12 does', () => {
    const unnamed = fn({ signature: 'f(json)', argnames: [''], argtypes: ['json'] });
    const chosen = chooseOverload([unnamed], ['x', 'y'], { strict: true });
    expect(chosen?.singleJson).toBe(true);
    expect(chosen?.jsonType).toBe('json');
  });

  it('returns null when there is no such function at all', () => {
    expect(chooseOverload([], [], { strict: true })).toBeNull();
  });
});

describe('callShape', () => {
  it('tells void, composite and scalar results apart', () => {
    expect(callShape(fn({ typtype: 'p', typname: 'void' }))).toBe('void');
    expect(callShape(fn({ typtype: 'p', typname: 'record' }))).toBe('composite');
    expect(callShape(fn({ typtype: 'c', typname: 'posts', typrelid: 1234 }))).toBe('composite');
    expect(callShape(fn({ typtype: 'b', typname: 'int4', typrelid: 0 }))).toBe('scalar');
    expect(callShape(fn({ typtype: 'b', typname: 'jsonb', typrelid: '0' }))).toBe('scalar');
    expect(callShape(fn({ typtype: 'e', typname: 'mood' }))).toBe('scalar');
  });
});
