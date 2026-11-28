import {
  MAX_VECTOR_DIMENSIONS,
  TopK,
  cosineDistance,
  decodeFloat32,
  dot,
  encodeFloat32,
  normalize,
  prepareVector,
  validateVector,
} from '../vector/vector-math';

describe('validateVector', () => {
  it('accepts finite numbers', () => {
    expect(validateVector([1, -2.5, 0])).toEqual([1, -2.5, 0]);
  });

  it.each([
    ['not an array', 'x'],
    ['empty', []],
    ['NaN', [1, NaN]],
    ['Infinity', [Infinity, 1]],
    ['a string item', [1, '2']],
    ['null item', [null]],
  ])('rejects %s with VECTOR_INVALID', (_label, v) => {
    expect(() => validateVector(v)).toThrow(expect.objectContaining({ code: 'VECTOR_INVALID', statusCode: 400 }));
  });

  it('rejects vectors wider than the maximum', () => {
    const v = new Array(MAX_VECTOR_DIMENSIONS + 1).fill(1);
    expect(() => validateVector(v)).toThrow(expect.objectContaining({ code: 'VECTOR_DIMENSION_MISMATCH' }));
  });

  it('rejects a width other than the configured one', () => {
    expect(() => validateVector([1, 2, 3], { expected: 4 })).toThrow(/configured for 4/);
  });
});

describe('normalize', () => {
  it('returns a unit vector in float64', () => {
    const n = normalize([3, 4]);
    expect(n).toBeInstanceOf(Float64Array);
    expect(n[0]).toBeCloseTo(0.6, 12);
    expect(n[1]).toBeCloseTo(0.8, 12);
  });

  it('rejects the zero vector', () => {
    expect(() => normalize([0, 0, 0])).toThrow(expect.objectContaining({ code: 'VECTOR_INVALID' }));
  });

  it('does not overflow on huge components', () => {
    const n = normalize([1e300, 1e300]);
    expect(n[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(Number.isFinite(n[1])).toBe(true);
  });

  it('prepareVector validates then normalises', () => {
    expect(Array.from(prepareVector([0, 5]))).toEqual([0, 1]);
    expect(() => prepareVector([0, 0])).toThrow(/zeros/);
  });
});

describe('float32 encoding (BSON vector layout)', () => {
  it('writes the float32 dtype header and little-endian values, and reads them back', () => {
    const bytes = encodeFloat32([1, -0.5, 0.25]);
    expect(bytes.length).toBe(2 + 3 * 4);
    expect(bytes[0]).toBe(0x27);
    expect(bytes[1]).toBe(0);
    expect(Array.from(decodeFloat32(bytes))).toEqual([1, -0.5, 0.25]);
  });

  it('refuses a payload that is not float32', () => {
    expect(() => decodeFloat32(new Uint8Array([0x03, 0, 1, 2]))).toThrow(/float32/);
    expect(() => decodeFloat32(new Uint8Array([0x27, 0, 1]))).toThrow(/float32/);
  });
});

describe('dot / cosineDistance', () => {
  it('scores same, orthogonal and opposite directions', () => {
    const a = normalize([1, 0]);
    expect(dot(a, a)).toBeCloseTo(1, 12);
    expect(cosineDistance(a, normalize([0, 1]))).toBeCloseTo(1, 12);
    expect(cosineDistance(a, normalize([-1, 0]))).toBeCloseTo(2, 12);
  });

  it('refuses vectors of different widths', () => {
    expect(() => dot([1, 2], [1])).toThrow(/dimensions/);
  });
});

describe('TopK', () => {
  it('keeps the k best items, best first, ties broken by id', () => {
    const top = new TopK<{ id: string; score: number }>(3);
    for (const [id, score] of [['a', 0.1], ['b', 0.9], ['c', 0.5], ['d', 0.9], ['e', 0.2], ['f', 0.7]] as const) {
      top.push({ id, score });
    }
    expect(top.sorted().map((x) => x.id)).toEqual(['b', 'd', 'f']);
  });

  it('matches a full sort on random input', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `id${String(i).padStart(4, '0')}`, score: Math.round(Math.random() * 50) / 50 }));
    const top = new TopK<{ id: string; score: number }>(17);
    items.forEach((x) => top.push(x));
    const reference = [...items]
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, 17);
    expect(top.sorted()).toEqual(reference);
  });

  it('rejects a non-positive k', () => {
    expect(() => new TopK(0)).toThrow(RangeError);
  });
});
