import { BadRequestException } from '@nestjs/common';
import { MAX_SOURCE_CHARS, buildSourceText, sourceHash, validateSourcePaths } from './vector-source';

describe('validateSourcePaths', () => {
  it('accepts 1..8 distinct dot paths', () => {
    expect(validateSourcePaths(['title', 'body.text'])).toEqual(['title', 'body.text']);
    expect(validateSourcePaths(Array.from({ length: 8 }, (_, i) => `f${i}`))).toHaveLength(8);
  });

  it.each([
    [[]],
    [Array.from({ length: 9 }, (_, i) => `f${i}`)],
    ['title'],
    [['']],
    [[3]],
    [['tags[]']],
    [['a b']],
    [['__proto__']],
    [['a.constructor']],
    [['$where']],
    [['title', 'title']],
  ])('refuses %j', (paths) => {
    expect(() => validateSourcePaths(paths)).toThrow(BadRequestException);
  });
});

describe('buildSourceText', () => {
  const data = {
    title: 'Red shoes',
    body: { text: 'Leather, size 42', empty: '' },
    price: 89.5,
    inStock: true,
    tags: ['a', 'b'],
    nothing: null,
  };

  it('joins the values in the declared order with newlines', () => {
    expect(buildSourceText(data, ['title', 'body.text'])).toBe('Red shoes\nLeather, size 42');
    expect(buildSourceText(data, ['body.text', 'title'])).toBe('Leather, size 42\nRed shoes');
  });

  it('JSON-stringifies non-string leaves', () => {
    expect(buildSourceText(data, ['price', 'inStock', 'tags'])).toBe('89.5\ntrue\n["a","b"]');
  });

  it('skips missing paths, null and empty strings', () => {
    expect(buildSourceText(data, ['missing', 'nothing', 'body.empty', 'title', 'title.deeper'])).toBe('Red shoes');
  });

  it('is empty when there is nothing to embed', () => {
    expect(buildSourceText(data, ['missing', 'nothing'])).toBe('');
    expect(buildSourceText({}, ['title'])).toBe('');
  });

  it('does not walk inherited properties', () => {
    expect(buildSourceText({}, ['toString'])).toBe('');
  });

  it('cuts very long text', () => {
    const out = buildSourceText({ t: 'x'.repeat(MAX_SOURCE_CHARS + 100) }, ['t']);
    expect(out).toHaveLength(MAX_SOURCE_CHARS);
  });
});

describe('sourceHash', () => {
  it('is the sha256 hex of the text, stable and sensitive to any change', () => {
    expect(sourceHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sourceHash('Red shoes')).toBe(sourceHash('Red shoes'));
    expect(sourceHash('Red shoes')).not.toBe(sourceHash('Red shoes '));
    expect(sourceHash('a\nb')).not.toBe(sourceHash('b\na'));
  });
});
