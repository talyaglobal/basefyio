/**
 * `{{ … }}` placeholders in flow actions.
 *
 * A placeholder is a dotted path into the run's context — nothing else. There
 * is no expression language, no function call and no access to anything but
 * the plain data below, so a template cannot reach the process, the platform
 * or another project:
 *
 *   {{input.customer.email}}     the run's input (trigger body / webhook payload)
 *   {{steps.0.status}}           an earlier step, by position…
 *   {{steps.fetchUser.body.id}}  …or by its name
 *   {{trigger.headers.x-github-event}}, {{trigger.query.ref}}, {{trigger.scheduledFor}}
 *   {{run.id}}, {{run.startedAt}}, {{flow.id}}, {{flow.name}}, {{now}}
 *
 * Array items are addressed as `items.0` or `items[0]`.
 *
 * A placeholder that resolves to nothing becomes an empty string and is
 * reported back as a warning on the step, so a typo shows up in the run
 * details instead of silently sending "{{input.x}}" to a remote server.
 */

export interface TemplateContext {
  input?: unknown;
  steps?: unknown;
  trigger?: unknown;
  run?: unknown;
  flow?: unknown;
  now?: string;
}

export interface RenderResult<T> {
  value: T;
  /** Placeholders that resolved to undefined/null. */
  missing: string[];
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^{}]*?)\s*\}\}$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const ROOTS = new Set(['input', 'steps', 'trigger', 'run', 'flow', 'now']);

/** Split `a.b[0].c` into ['a','b','0','c']. Returns null on bad syntax. */
export function parsePath(expr: string): string[] | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  const normalised = trimmed.replace(/\[(\d+)\]/g, '.$1');
  const segments = normalised.split('.');
  for (const s of segments) {
    if (!/^[A-Za-z0-9_$-]+$/.test(s)) return null;
    if (FORBIDDEN_SEGMENTS.has(s)) return null;
  }
  return segments;
}

/** Resolve a path against the context, own properties only. */
export function resolvePath(ctx: TemplateContext, expr: string): unknown {
  const segments = parsePath(expr);
  if (!segments || !ROOTS.has(segments[0])) return undefined;
  let cur: unknown = ctx;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

export type StringMode = 'text' | 'url' | 'header';

/**
 * Render placeholders inside a string.
 *  - text:   values inserted as-is (objects as JSON).
 *  - url:    values inserted URL-encoded, except when the placeholder is the
 *            whole string (a URL taken from the input is used as given — it is
 *            still checked by the SSRF guard before any request).
 *  - header: line breaks stripped, so a value cannot add a header of its own.
 */
export function renderString(template: string, ctx: TemplateContext, mode: StringMode = 'text'): RenderResult<string> {
  const missing: string[] = [];
  if (typeof template !== 'string' || !template.includes('{{')) {
    return { value: template, missing };
  }
  const whole = template.match(WHOLE);
  if (whole && mode === 'url') {
    const v = resolvePath(ctx, whole[1]);
    if (v === undefined || v === null) missing.push(whole[1]);
    return { value: stringify(v), missing };
  }
  let value = template.replace(PLACEHOLDER, (_m, expr: string) => {
    const v = resolvePath(ctx, expr);
    if (v === undefined || v === null) {
      missing.push(expr);
      return '';
    }
    const s = stringify(v);
    return mode === 'url' ? encodeURIComponent(s) : s;
  });
  if (mode === 'header') value = value.replace(/[\r\n]+/g, ' ');
  return { value, missing };
}

/**
 * Render every string inside a JSON-like value. A string that is exactly one
 * placeholder takes the referenced value with its type, so
 * `{ "total": "{{input.total}}" }` sends a number when the input has one.
 */
export function renderValue(value: unknown, ctx: TemplateContext, depth = 0): RenderResult<unknown> {
  const missing: string[] = [];
  const walk = (v: unknown, d: number): unknown => {
    if (d > 20) return v;
    if (typeof v === 'string') {
      const whole = v.match(WHOLE);
      if (whole) {
        const resolved = resolvePath(ctx, whole[1]);
        if (resolved === undefined || resolved === null) {
          missing.push(whole[1]);
          return null;
        }
        return resolved;
      }
      const r = renderString(v, ctx, 'text');
      missing.push(...r.missing);
      return r.value;
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, d + 1));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN_SEGMENTS.has(k)) continue;
        out[k] = walk(item, d + 1);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, depth), missing };
}

/** Every placeholder expression in a value, for validation at save time. */
export function listPlaceholders(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown, d: number) => {
    if (d > 20) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(PLACEHOLDER)) found.push(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach((item) => walk(item, d + 1));
    } else if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach((item) => walk(item, d + 1));
    }
  };
  walk(value, 0);
  return found;
}

/** null when the placeholder can be resolved at run time, else why not. */
export function placeholderError(expr: string): string | null {
  const segments = parsePath(expr);
  if (!segments) return `"{{${expr}}}" is not a valid placeholder (use a dotted path such as {{input.id}})`;
  if (!ROOTS.has(segments[0])) {
    return `"{{${expr}}}" must start with one of: ${[...ROOTS].join(', ')}`;
  }
  return null;
}
