/**
 * Choosing which function a call means, and what its result looks like.
 *
 * PostgREST resolves `rpc/<fn>` against every overload in `public` by the
 * argument names sent: the overload whose input parameters cover the keys,
 * and whose parameters without defaults are all present. A function's
 * return type then decides the body — a bare value, one object, or an
 * array. The catalogue row this works from is the one `PublicApiService.rpc`
 * queries; everything here is pure so it can be tested without a database.
 */

/** One `pg_proc` row joined to its return type. */
export interface FunctionMeta {
  signature: string;
  definer: boolean;
  /** `proargnames` — includes OUT parameters when `argmodes` is non-empty. */
  argnames: string[];
  /** `proargmodes`: i / o / b / v / t per name; empty when every parameter is IN. */
  argmodes: string[];
  /** `format_type` of each IN parameter, in order. */
  argtypes?: string[];
  pronargs?: number;
  pronargdefaults?: number;
  proretset?: boolean;
  provolatile?: string;
  /** Return type: typtype (b/c/d/e/p/r/m), its name and, for a table type, the relation. */
  typtype?: string;
  typname?: string;
  typrelid?: number | string;
}

export interface RpcCall {
  meta: FunctionMeta;
  /** Input parameter names, in declaration order. */
  inputs: string[];
  /** The whole body is passed as the function's single JSON parameter. */
  singleJson: boolean;
  jsonType: 'json' | 'jsonb';
}

const INPUT_MODES = new Set(['i', 'b', 'v']);

/** Names of the input parameters (IN, INOUT, VARIADIC), in order. */
export function inputNames(meta: FunctionMeta): string[] {
  const names = meta.argnames ?? [];
  const modes = meta.argmodes ?? [];
  if (!modes.length) return names.map((n) => n ?? '');
  return names.filter((_, i) => INPUT_MODES.has(modes[i] ?? 'i')).map((n) => n ?? '');
}

/** The single JSON type a one-parameter function takes, if that is what it is. */
function singleJsonType(meta: FunctionMeta, inputs: string[]): 'json' | 'jsonb' | null {
  if (inputs.length !== 1) return null;
  const t = (meta.argtypes ?? [])[0];
  return t === 'json' || t === 'jsonb' ? t : null;
}

/**
 * Pick the overload a set of argument keys addresses.
 *
 * `strict` is PostgREST's rule (a key no overload knows is "not found");
 * without it a key the function does not name is ignored, which is what
 * this API always did for its own SDKs. `singleObject` is
 * `Prefer: params=single-object`: the body as a whole goes to the one JSON
 * parameter. A single unnamed JSON parameter is treated the same way
 * without the header, as PostgREST 12 does.
 */
export function chooseOverload(
  metas: FunctionMeta[],
  keys: string[],
  options: { strict?: boolean; singleObject?: boolean } = {},
): RpcCall | null {
  const candidates: RpcCall[] = metas.map((meta) => {
    const inputs = inputNames(meta);
    const json = singleJsonType(meta, inputs);
    const unnamed = inputs.length === 1 && inputs[0] === '';
    const singleJson = json !== null && (options.singleObject === true || unnamed);
    return { meta, inputs, singleJson, jsonType: json ?? 'json' };
  });

  if (options.singleObject) {
    return candidates.find((c) => c.singleJson) ?? null;
  }

  const sent = new Set(keys);
  const matching = candidates.filter((c) => {
    if (c.singleJson) return true;
    const defaults = c.meta.pronargdefaults ?? 0;
    const required = c.inputs.slice(0, Math.max(0, c.inputs.length - defaults));
    if (!required.every((n) => sent.has(n))) return false;
    if (options.strict && !keys.every((k) => c.inputs.includes(k))) return false;
    return true;
  });
  if (!matching.length) return null;
  // Exact coverage first; then the overload that uses most of what was sent.
  const score = (c: RpcCall) => (c.singleJson ? -1 : c.inputs.filter((n) => sent.has(n)).length);
  matching.sort((a, b) => {
    const exactA = !a.singleJson && a.inputs.length === keys.length && keys.every((k) => a.inputs.includes(k));
    const exactB = !b.singleJson && b.inputs.length === keys.length && keys.every((k) => b.inputs.includes(k));
    if (exactA !== exactB) return exactA ? -1 : 1;
    return score(b) - score(a);
  });
  return matching[0];
}

export type CallShape = 'void' | 'scalar' | 'composite';

/**
 * How to read the result: `void` has none; a composite type (a table, a
 * row type, or `record` with OUT parameters) is read as columns; anything
 * else — base types, enums, domains, ranges, json — is one value.
 */
export function callShape(meta: FunctionMeta): CallShape {
  if (meta.typname === 'void') return 'void';
  if (meta.typtype === 'c') return 'composite';
  if (meta.typname === 'record') return 'composite';
  const rel = Number(meta.typrelid ?? 0);
  if (rel) return 'composite';
  return 'scalar';
}
