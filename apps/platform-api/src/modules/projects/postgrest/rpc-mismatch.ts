import type { FunctionMeta } from './rpc';

/** The IN-style parameters of an overload, by name, in order (OUT and TABLE columns left out). */
function inputNames(meta: FunctionMeta): string[] {
  const names = meta.argnames ?? [];
  const modes = meta.argmodes ?? [];
  if (!modes.length) return names.filter((n) => n);
  return names.filter((n, i) => n && ['i', 'b', 'v'].includes(modes[i] ?? 'i'));
}

/** The parameters with no default, which a call has to name. They are the leading ones. */
function requiredNames(meta: FunctionMeta): string[] {
  const inputs = inputNames(meta);
  const total = meta.pronargs ?? inputs.length;
  const required = Math.max(0, total - (meta.pronargdefaults ?? 0));
  return inputs.slice(0, required);
}

/**
 * Why a call did not match a function that does exist.
 *
 * It used to say `Function "x" not found`, which is false and sends the caller
 * (or a readiness probe) looking for a function that is there: the call just
 * left out an argument. This names the missing or unknown argument instead.
 */
export function describeRpcMismatch(fnName: string, overloads: FunctionMeta[], sentKeys: string[]): string {
  const sent = new Set(sentKeys);

  if (overloads.length === 1) {
    const meta = overloads[0];
    const inputs = inputNames(meta);
    const missing = requiredNames(meta).filter((n) => !sent.has(n));
    const unknown = sentKeys.filter((k) => !inputs.includes(k));
    const parts: string[] = [];
    if (missing.length) parts.push(`missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    if (unknown.length) parts.push(`unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    const takes = inputs.length ? `It takes: ${inputs.join(', ')}.` : 'It takes no arguments.';
    return parts.length
      ? `Function "${fnName}" exists but the call does not match it — ${parts.join('; ')}. ${takes}`
      : `Function "${fnName}" exists but the call does not match it. ${takes}`;
  }

  const list = overloads.map((m) => m.signature).join('; ');
  return `Function "${fnName}" exists but no overload matches the arguments sent (${sentKeys.length ? sentKeys.join(', ') : 'none'}). Overloads: ${list}`;
}
