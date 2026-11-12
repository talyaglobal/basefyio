import { PostgrestParseError } from './types';

/**
 * Turning an RPC request body into a function call.
 *
 * The body's keys are argument names. Postgres can resolve a named call
 * itself, but when it cannot it answers "function does not exist", which says
 * nothing about what to send instead — and a function with the same name can
 * have several overloads, one of them SECURITY DEFINER. So the overloads are
 * matched here first, from the catalogue: the call goes out only when some
 * overload takes the arguments given, and the definer check looks at the
 * overloads that can actually be reached.
 */

/** One row of the pg_proc lookup in PublicApiService.rpc. */
export interface RpcOverloadRow {
  signature: string;
  definer: boolean;
  /** pronargdefaults: the last this-many input arguments have defaults. */
  ndefaults?: number | null;
  /** proargnames — every argument, OUT ones included when there are any. */
  argnames?: string[] | null;
  /** proargmodes — i, o, b (inout), v (variadic), t (table column); empty means all IN. */
  argmodes?: string[] | null;
  /** Declared types, aligned with argnames. */
  argtypes?: string[] | null;
}

interface InputArg {
  name: string;
  type: string;
  hasDefault: boolean;
  /** A VARIADIC argument, which named notation has to call out. */
  variadic: boolean;
}

interface Overload {
  signature: string;
  definer: boolean;
  inputs: InputArg[];
}

export interface RpcCallPlan {
  /** `"a" := $1, "b" := $2` — empty for a call with no arguments. */
  named: string;
  params: unknown[];
  /** Whether any overload the call can reach is SECURITY DEFINER. */
  definer: boolean;
}

function describe(row: RpcOverloadRow): Overload {
  const names = row.argnames ?? [];
  const modes = row.argmodes ?? [];
  const types = row.argtypes ?? [];
  const positions = Math.max(names.length, types.length);
  const inputs: InputArg[] = [];
  for (let i = 0; i < positions; i++) {
    const mode = modes.length ? modes[i] : 'i';
    if (mode !== 'i' && mode !== 'b' && mode !== 'v') continue;
    inputs.push({
      name: names[i] ?? '',
      type: (types[i] ?? '').toLowerCase(),
      hasDefault: false,
      variadic: mode === 'v',
    });
  }
  const ndefaults = Math.max(0, Number(row.ndefaults ?? 0));
  for (let i = Math.max(0, inputs.length - ndefaults); i < inputs.length; i++) {
    inputs[i].hasDefault = true;
  }
  return { signature: row.signature, definer: !!row.definer, inputs };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const JSON_TYPES = new Set(['json', 'jsonb']);

/**
 * Work out the call for `args` against the function's overloads.
 *
 * A key no overload knows is ignored, as it always was — an extra field in a
 * body does not break a call. An overload is callable when it takes every
 * known key and every argument it requires (one without a default) was given.
 * When none is, the error lists what does exist.
 *
 * A value for a json/jsonb argument is sent as JSON text, so an array arrives
 * as a JSON array rather than as a Postgres array literal.
 */
export function planRpcCall(
  fnName: string,
  rows: RpcOverloadRow[],
  args: Record<string, unknown>,
): RpcCallPlan {
  const overloads = rows.map(describe);
  const known = new Set(overloads.flatMap((o) => o.inputs.map((a) => a.name).filter(Boolean)));
  const keys = Object.keys(args);
  const provided = keys.filter((k) => known.has(k));
  const ignored = keys.filter((k) => !known.has(k));

  const candidates = overloads.filter((o) => {
    const names = new Set(o.inputs.map((a) => a.name));
    if (!provided.every((k) => names.has(k))) return false;
    return o.inputs.every((a) => a.hasDefault || (a.name !== '' && provided.includes(a.name)));
  });

  if (!candidates.length) {
    const available = overloads.map((o) => o.signature).join(', ');
    const sent = provided.length ? `(${provided.join(', ')})` : 'no arguments';
    const extra = ignored.length
      ? ` Unknown argument name${ignored.length > 1 ? 's' : ''}: ${ignored.join(', ')}.`
      : '';
    throw new PostgrestParseError(
      `Function "${fnName}" cannot be called with ${sent}.${extra} ` +
        `Send the arguments as a JSON object keyed by argument name. Available: ${available}`,
      undefined,
      'PGRST202',
    );
  }

  const params: unknown[] = [];
  const named = provided
    .map((k) => {
      const declared = candidates.map((o) => o.inputs.find((a) => a.name === k));
      const isJson = declared.every((a) => !!a && JSON_TYPES.has(a.type));
      // Passing a VARIADIC argument by name takes the keyword: VARIADIC "xs" := …
      const variadic = declared.every((a) => !!a?.variadic) ? 'VARIADIC ' : '';
      const value = args[k];
      params.push(isJson && value !== null && value !== undefined ? JSON.stringify(value) : value ?? null);
      return `${variadic}${quoteIdent(k)} := $${params.length}`;
    })
    .join(', ');

  return { named, params, definer: candidates.some((o) => o.definer) };
}
