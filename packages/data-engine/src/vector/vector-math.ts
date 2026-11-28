/**
 * Pure vector helpers: validation, unit normalisation, float32 encoding in the
 * BSON vector layout (binary subtype 9), dot product and a bounded top-k heap.
 *
 * No driver import here: unit-testable on its own.
 */

import { VectorDimensionError, VectorInvalidError } from '../interfaces/data-engine';

/** Widest vector any provider stores today. */
export const MAX_VECTOR_DIMENSIONS = 2048;

/** BSON binary subtype for vectors, and its float32 dtype byte. */
export const BSON_VECTOR_SUBTYPE = 9;
export const BSON_VECTOR_FLOAT32 = 0x27;

/**
 * Checks a client vector: a non-empty array of finite numbers, at most
 * `maxDimensions` long and, when `expected` is set, exactly that long.
 */
export function validateVector(
  vector: unknown,
  opts: { expected?: number; maxDimensions?: number } = {},
): number[] {
  const max = opts.maxDimensions ?? MAX_VECTOR_DIMENSIONS;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new VectorInvalidError('vector must be a non-empty array of numbers');
  }
  if (vector.length > max) {
    throw new VectorDimensionError(`vector has ${vector.length} dimensions; at most ${max} are supported`);
  }
  if (opts.expected !== undefined && vector.length !== opts.expected) {
    throw new VectorDimensionError(
      `vector has ${vector.length} dimensions; this entity is configured for ${opts.expected}`,
    );
  }
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new VectorInvalidError(`vector[${i}] must be a finite number`);
    }
  }
  return vector as number[];
}

/**
 * Unit-length copy in float64. The norm is computed after scaling by the
 * largest magnitude, so huge components cannot overflow to Infinity. A zero
 * vector has no direction and is rejected.
 */
export function normalize(vector: number[]): Float64Array {
  let maxAbs = 0;
  for (const x of vector) {
    const a = Math.abs(x);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) {
    throw new VectorInvalidError('vector must not be all zeros');
  }
  let sum = 0;
  for (const x of vector) {
    const s = x / maxAbs;
    sum += s * s;
  }
  const norm = maxAbs * Math.sqrt(sum);
  const out = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/** Validate then normalise: the one call writers and searchers use. */
export function prepareVector(
  vector: unknown,
  opts: { expected?: number; maxDimensions?: number } = {},
): Float64Array {
  return normalize(validateVector(vector, opts));
}

/**
 * BSON vector payload for float32: [dtype 0x27, padding 0, ...little-endian floats].
 * This is what `Binary.fromFloat32Array` writes; used when the driver lacks it.
 */
export function encodeFloat32(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(2 + values.length * 4);
  out[0] = BSON_VECTOR_FLOAT32;
  out[1] = 0;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < values.length; i++) view.setFloat32(2 + i * 4, values[i], true);
  return out;
}

/** Inverse of encodeFloat32. A payload that is not a float32 vector is a VectorInvalidError. */
export function decodeFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.length < 2 || bytes[0] !== BSON_VECTOR_FLOAT32 || (bytes.length - 2) % 4 !== 0) {
    throw new VectorInvalidError('stored vector is not a float32 vector');
  }
  const n = (bytes.length - 2) / 4;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(2 + i * 4, true);
  return out;
}

/** Dot product in float64. Lengths must match (callers filter by width). */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new VectorDimensionError(`cannot compare vectors of ${a.length} and ${b.length} dimensions`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Cosine distance between unit vectors, clamped to 0..2 against rounding. */
export function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = 1 - dot(a, b);
  return d < 0 ? 0 : d > 2 ? 2 : d;
}

export interface Scored {
  id: string;
  score: number;
}

/** True when `a` ranks below `b`: lower score, or same score and later id. */
function worse(a: Scored, b: Scored): boolean {
  return a.score < b.score || (a.score === b.score && a.id > b.id);
}

/**
 * Keeps the k best items seen so far in O(n log k): a min-heap whose root is
 * the worst kept item. Ties are broken by id so results are deterministic.
 */
export class TopK<T extends Scored> {
  private readonly heap: T[] = [];

  constructor(private readonly k: number) {
    if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be a positive integer');
  }

  get size(): number {
    return this.heap.length;
  }

  push(item: T): void {
    const h = this.heap;
    if (h.length < this.k) {
      h.push(item);
      this.up(h.length - 1);
    } else if (worse(h[0], item)) {
      h[0] = item;
      this.down(0);
    }
  }

  /** Kept items, best first. */
  sorted(): T[] {
    return [...this.heap].sort((a, b) => (worse(a, b) ? 1 : worse(b, a) ? -1 : 0));
  }

  private up(i: number): void {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!worse(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  private down(i: number): void {
    const h = this.heap;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && worse(h[l], h[m])) m = l;
      if (r < h.length && worse(h[r], h[m])) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
}
