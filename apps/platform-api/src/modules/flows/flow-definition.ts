import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { cronError, isValidTimeZone } from './flow-cron';
import { listPlaceholders, placeholderError } from './flow-template';
import {
  FlowAction,
  FlowActionType,
  FlowHttpMethod,
  FlowOptions,
  FlowTrigger,
  FlowTriggerType,
} from './flow.types';

/**
 * One reading of a flow definition for every path that touches it: the API
 * validates and normalises what it stores, the worker and the dashboard read
 * stored rows through the same functions.
 *
 * Normalising on save means a definition only ever holds the fields its type
 * uses. That fixes a stale `message` left on an action switched from log to
 * http.request, and stops unknown fields being stored as if they did
 * something. Rows written before this existed are read through
 * `readStoredAction`, which never throws: an old flow keeps running exactly as
 * it did (e.g. http.request without a method still sends POST).
 */

export const TRIGGER_TYPES: FlowTriggerType[] = ['manual', 'webhook', 'schedule'];
export const ACTION_TYPES: FlowActionType[] = ['log', 'http.request', 'db.select', 'db.insert', 'db.update'];
export const HTTP_METHODS: FlowHttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

/** Bounds for every configurable limit. Defaults apply when a field is unset. */
export const FLOW_LIMITS = {
  maxActions: 25,
  nameMax: 120,
  stepNameMax: 60,
  logMessageMax: 2000,
  urlMax: 2048,
  headersMax: 30,
  headerValueMax: 4096,
  bodyMaxBytes: 64 * 1024,
  timeoutMs: { min: 1_000, max: 30_000, default: 10_000 },
  retries: { min: 0, max: 5, default: 0 },
  retryDelayMs: { min: 0, max: 60_000, default: 1_000 },
  maxDurationMs: { min: 10_000, max: 900_000, default: 300_000 },
  maxConcurrentRuns: { min: 1, max: 20 },
  selectLimit: { min: 1, max: 1000, default: 100 },
} as const;

/** What a masked header value looks like in API responses. */
export const MASKED_VALUE = '********';

const SENSITIVE_HEADER = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|apikey|signature|credential|session|^x-auth)/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name);
}

const STEP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const ACTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function bad(message: string): never {
  throw new BadRequestException(message);
}

function newActionId(): string {
  return `a_${randomBytes(6).toString('hex')}`;
}

function intInRange(
  value: unknown,
  field: string,
  bounds: { min: number; max: number },
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) bad(`${field} must be a whole number`);
  if (n < bounds.min || n > bounds.max) bad(`${field} must be between ${bounds.min} and ${bounds.max}`);
  return n;
}

function checkPlaceholders(value: unknown, field: string): void {
  for (const expr of listPlaceholders(value)) {
    const err = placeholderError(expr);
    if (err) bad(`${field}: ${err}`);
  }
}

export function normalizeTrigger(raw: unknown): FlowTrigger {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (!t || typeof t !== 'object' || !TRIGGER_TYPES.includes(t.type as FlowTriggerType)) {
    bad(`trigger.type must be one of ${TRIGGER_TYPES.join(', ')}`);
  }
  const type = t.type as FlowTriggerType;
  if (type === 'schedule') {
    const cron = typeof t.cron === 'string' ? t.cron.trim().replace(/\s+/g, ' ') : '';
    if (!cron) {
      bad(
        'trigger.cron is required for a schedule trigger — a 5-field cron expression such as "*/15 * * * *" (every 15 minutes)',
      );
    }
    const err = cronError(cron);
    if (err) bad(`trigger.cron is not a valid cron expression: ${err}`);
    const out: FlowTrigger = { type, cron };
    if (t.timezone !== undefined && t.timezone !== null && t.timezone !== '') {
      if (typeof t.timezone !== 'string' || !isValidTimeZone(t.timezone)) {
        bad(`trigger.timezone "${String(t.timezone)}" is not a known IANA time zone (e.g. "Europe/Istanbul")`);
      }
      if (t.timezone !== 'UTC') out.timezone = t.timezone;
    }
    return out;
  }
  if (type === 'webhook') {
    const out: FlowTrigger = { type };
    // Kept only for flows that stored it; the flow's own URL is its webhookId.
    if (typeof t.webhookPath === 'string' && t.webhookPath.trim()) out.webhookPath = t.webhookPath.trim().slice(0, 200);
    return out;
  }
  return { type };
}

export function normalizeOptions(raw: unknown): FlowOptions | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) bad('options must be an object');
  const o = raw as Record<string, unknown>;
  const out: FlowOptions = {};
  const timeoutMs = intInRange(o.timeoutMs, 'options.timeoutMs', FLOW_LIMITS.timeoutMs);
  const retries = intInRange(o.retries, 'options.retries', FLOW_LIMITS.retries);
  const retryDelayMs = intInRange(o.retryDelayMs, 'options.retryDelayMs', FLOW_LIMITS.retryDelayMs);
  const maxDurationMs = intInRange(o.maxDurationMs, 'options.maxDurationMs', FLOW_LIMITS.maxDurationMs);
  const maxConcurrentRuns = intInRange(o.maxConcurrentRuns, 'options.maxConcurrentRuns', FLOW_LIMITS.maxConcurrentRuns);
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  if (retries !== undefined) out.retries = retries;
  if (retryDelayMs !== undefined) out.retryDelayMs = retryDelayMs;
  if (maxDurationMs !== undefined) out.maxDurationMs = maxDurationMs;
  if (maxConcurrentRuns !== undefined) out.maxConcurrentRuns = maxConcurrentRuns;
  return Object.keys(out).length ? out : null;
}

function normalizeHeaders(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) bad(`${field} must be an object of header names to values`);
  const entries = Object.entries(raw as Record<string, unknown>).filter(([k]) => k.trim() !== '');
  if (entries.length > FLOW_LIMITS.headersMax) bad(`${field} can hold at most ${FLOW_LIMITS.headersMax} headers`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const name = k.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) bad(`${field}: "${name}" is not a valid header name`);
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      bad(`${field}.${name} must be a string`);
    }
    const value = String(v);
    if (value.length > FLOW_LIMITS.headerValueMax) bad(`${field}.${name} is too long`);
    if (/[\r\n]/.test(value)) bad(`${field}.${name} must not contain line breaks`);
    out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeFilters(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    bad(`${field} must be an object such as { "id": "eq.{{input.id}}" }`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const col = k.trim();
    if (!col) continue;
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(col)) {
      bad(`${field}: "${col}" is not a filter (use the action's own select/limit fields)`);
    }
    if (typeof v !== 'string' || !v.trim()) bad(`${field}.${col} must be a filter such as "eq.42"`);
    if (!/^(not\.)?[a-z]+\./.test(v.trim())) {
      bad(`${field}.${col} must start with an operator, e.g. "eq.42", "gt.10", "in.(1,2)"`);
    }
    out[col] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Validate one action and keep only the fields its type uses.
 * `stored` is the same action as currently saved (matched by id or position),
 * used to keep header values the API returned masked.
 */
export function normalizeAction(raw: unknown, index: number, stored?: FlowAction): FlowAction {
  const at = `actions[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`${at} must be an object`);
  const a = raw as Record<string, unknown>;
  if (!ACTION_TYPES.includes(a.type as FlowActionType)) {
    bad(`${at}.type must be one of ${ACTION_TYPES.join(', ')}`);
  }
  const type = a.type as FlowActionType;
  const out: FlowAction = {
    id: typeof a.id === 'string' && ACTION_ID.test(a.id) ? a.id : newActionId(),
    type,
  };

  if (a.name !== undefined && a.name !== null && a.name !== '') {
    if (typeof a.name !== 'string' || !STEP_NAME.test(a.name)) {
      bad(`${at}.name must start with a letter and use only letters, digits and _ (max ${FLOW_LIMITS.stepNameMax})`);
    }
    out.name = a.name;
  }

  if (type === 'log') {
    const message = typeof a.message === 'string' ? a.message.trim() : '';
    if (!message) bad(`${at}.message is required for a log action`);
    if (message.length > FLOW_LIMITS.logMessageMax) bad(`${at}.message is longer than ${FLOW_LIMITS.logMessageMax} characters`);
    checkPlaceholders(message, `${at}.message`);
    out.message = message;
  }

  if (type === 'http.request') {
    const url = typeof a.url === 'string' ? a.url.trim() : '';
    if (!url) bad(`${at}.url is required for an http.request action`);
    if (url.length > FLOW_LIMITS.urlMax) bad(`${at}.url is too long`);
    checkPlaceholders(url, `${at}.url`);
    out.url = url;
    const method = a.method === undefined || a.method === null || a.method === ''
      ? 'POST'
      : String(a.method).toUpperCase();
    if (!HTTP_METHODS.includes(method as FlowHttpMethod)) {
      bad(`${at}.method must be one of ${HTTP_METHODS.join(', ')}`);
    }
    out.method = method as FlowHttpMethod;
    const headers = normalizeHeaders(a.headers, `${at}.headers`);
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (v === MASKED_VALUE) {
          const keep = findHeader(stored?.headers, k);
          if (keep === undefined) {
            bad(`${at}.headers.${k} is masked ("${MASKED_VALUE}"); enter the real value`);
          }
          // A kept secret only travels to where it was entered for: repointing
          // the action at another host must not carry the hidden value along.
          if (!sameOrigin(url, stored?.url)) {
            bad(`${at}.headers.${k} is masked and the URL's host changed; enter the value again`);
          }
          headers[k] = keep;
        }
      }
      checkPlaceholders(headers, `${at}.headers`);
      out.headers = headers;
    }
    if (a.body !== undefined && a.body !== null && a.body !== '') {
      if (method === 'GET' || method === 'HEAD') bad(`${at}.body cannot be sent with ${method}`);
      if (jsonSize(a.body) > FLOW_LIMITS.bodyMaxBytes) bad(`${at}.body is larger than ${FLOW_LIMITS.bodyMaxBytes / 1024} KB`);
      checkPlaceholders(a.body, `${at}.body`);
      out.body = a.body;
    }
    if (a.followRedirects !== undefined && a.followRedirects !== null) {
      if (typeof a.followRedirects !== 'boolean') bad(`${at}.followRedirects must be true or false`);
      if (a.followRedirects === false) out.followRedirects = false;
    }
  }

  if (type === 'db.select' || type === 'db.insert' || type === 'db.update') {
    const table = typeof a.table === 'string' ? a.table.trim() : '';
    if (!TABLE_NAME.test(table)) bad(`${at}.table must be a table name (letters, digits, _)`);
    out.table = table;
    const filters = normalizeFilters(a.filters, `${at}.filters`);
    if (type === 'db.select') {
      if (filters) {
        checkPlaceholders(filters, `${at}.filters`);
        out.filters = filters;
      }
      if (a.select !== undefined && a.select !== null && a.select !== '') {
        if (typeof a.select !== 'string' || !/^[A-Za-z0-9_,*\s]+$/.test(a.select)) {
          bad(`${at}.select must be a column list such as "id,email"`);
        }
        out.select = a.select.replace(/\s+/g, '');
      }
      const limit = intInRange(a.limit, `${at}.limit`, FLOW_LIMITS.selectLimit);
      if (limit !== undefined) out.limit = limit;
    } else {
      const values = a.values;
      const isRow = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
      if (type === 'db.insert') {
        const ok = isRow(values) || (Array.isArray(values) && values.length > 0 && values.length <= 100 && values.every(isRow));
        if (!ok) bad(`${at}.values must be a row object (or up to 100 rows) with at least one column`);
      } else if (!isRow(values)) {
        bad(`${at}.values must be an object of the columns to change`);
      }
      if (jsonSize(values) > FLOW_LIMITS.bodyMaxBytes) bad(`${at}.values is larger than ${FLOW_LIMITS.bodyMaxBytes / 1024} KB`);
      checkPlaceholders(values, `${at}.values`);
      out.values = values as FlowAction['values'];
      if (type === 'db.update') {
        if (!filters) bad(`${at}.filters is required for db.update, so it cannot change every row`);
        checkPlaceholders(filters, `${at}.filters`);
        out.filters = filters;
      }
    }
  }

  if (type !== 'log') {
    const timeoutMs = intInRange(a.timeoutMs, `${at}.timeoutMs`, FLOW_LIMITS.timeoutMs);
    if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  }
  const retries = intInRange(a.retries, `${at}.retries`, FLOW_LIMITS.retries);
  if (retries !== undefined) out.retries = retries;
  const retryDelayMs = intInRange(a.retryDelayMs, `${at}.retryDelayMs`, FLOW_LIMITS.retryDelayMs);
  if (retryDelayMs !== undefined) out.retryDelayMs = retryDelayMs;
  if (a.continueOnError === true) out.continueOnError = true;
  return out;
}

/** Same scheme+host+port. A templated host only matches the identical template. */
function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const origin = (u: string): string | null => {
    const m = u.match(/^(https?:\/\/[^/?#]*)/i);
    if (!m) return null;
    if (m[1].includes('{{')) return m[1];
    try {
      return new URL(m[1]).origin;
    } catch {
      return null;
    }
  };
  const oa = origin(a);
  return oa !== null && oa === origin(b);
}

function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export interface NormalizedDefinition {
  name: string;
  trigger: FlowTrigger;
  actions: FlowAction[];
  options: FlowOptions | null;
}

/**
 * Validate a whole definition. `storedActions` (an update) lets masked header
 * values through by matching each incoming action to the saved one with the
 * same id, or — for flows saved before actions had ids — the same position.
 */
export function normalizeDefinition(
  raw: unknown,
  storedActions: FlowAction[] = [],
): NormalizedDefinition {
  if (!raw || typeof raw !== 'object') bad('a flow definition object is required');
  const d = raw as Record<string, unknown>;
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  if (!name) bad('name is required');
  if (name.length > FLOW_LIMITS.nameMax) bad(`name is longer than ${FLOW_LIMITS.nameMax} characters`);
  const trigger = normalizeTrigger(d.trigger);
  if (!Array.isArray(d.actions) || d.actions.length === 0) bad('at least one action is required');
  if (d.actions.length > FLOW_LIMITS.maxActions) bad(`a flow can have at most ${FLOW_LIMITS.maxActions} actions`);
  const byId = new Map(storedActions.filter((s) => s.id).map((s) => [s.id as string, s]));
  const actions = d.actions.map((a, i) => {
    const id = a && typeof a === 'object' ? (a as FlowAction).id : undefined;
    const stored = (id && byId.get(id)) || (storedActions[i] && !storedActions[i].id ? storedActions[i] : undefined);
    return normalizeAction(a, i, stored);
  });
  const names = new Set<string>();
  for (const a of actions) {
    if (!a.name) continue;
    if (names.has(a.name)) bad(`two actions are named "${a.name}"; step names must be unique`);
    names.add(a.name);
  }
  const ids = new Set<string>();
  for (const a of actions) {
    if (ids.has(a.id as string)) a.id = newActionId();
    ids.add(a.id as string);
  }
  return { name, trigger, actions, options: normalizeOptions(d.options) };
}

// ── Reading stored rows (never throws) ──────────────────────────────────────

/** A stored trigger as the runtime sees it. Unknown shapes read as manual. */
export function readStoredTrigger(raw: unknown): FlowTrigger {
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const type = TRIGGER_TYPES.includes(t.type as FlowTriggerType) ? (t.type as FlowTriggerType) : 'manual';
  const out: FlowTrigger = { type };
  if (typeof t.cron === 'string') out.cron = t.cron;
  if (typeof t.timezone === 'string') out.timezone = t.timezone;
  if (typeof t.webhookPath === 'string') out.webhookPath = t.webhookPath;
  return out;
}

/**
 * A stored action as the runtime sees it, with the fields its type does not
 * use dropped. Legacy defaults are kept: http.request without a method sends
 * POST, which is what the executor always did.
 */
export function readStoredAction(raw: unknown, index: number): FlowAction {
  const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const type = (typeof a.type === 'string' ? a.type : 'log') as FlowActionType;
  const out: FlowAction = { id: typeof a.id === 'string' ? a.id : `legacy_${index}`, type };
  if (typeof a.name === 'string') out.name = a.name;
  if (type === 'log') {
    out.message = typeof a.message === 'string' ? a.message : '';
  } else if (type === 'http.request') {
    out.url = typeof a.url === 'string' ? a.url : '';
    out.method = (typeof a.method === 'string' && a.method ? a.method.toUpperCase() : 'POST') as FlowHttpMethod;
    if (a.headers && typeof a.headers === 'object' && !Array.isArray(a.headers)) {
      out.headers = Object.fromEntries(
        Object.entries(a.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
    if (a.body !== undefined) out.body = a.body;
    if (a.followRedirects === false) out.followRedirects = false;
  } else if (type === 'db.select' || type === 'db.insert' || type === 'db.update') {
    out.table = typeof a.table === 'string' ? a.table : '';
    if (a.filters && typeof a.filters === 'object') out.filters = a.filters as Record<string, string>;
    if (typeof a.select === 'string') out.select = a.select;
    if (typeof a.limit === 'number') out.limit = a.limit;
    if (a.values !== undefined) out.values = a.values as FlowAction['values'];
  }
  for (const key of ['timeoutMs', 'retries', 'retryDelayMs'] as const) {
    if (typeof a[key] === 'number') out[key] = a[key] as number;
  }
  if (a.continueOnError === true) out.continueOnError = true;
  return out;
}

export function readStoredActions(raw: unknown): FlowAction[] {
  return Array.isArray(raw) ? raw.map((a, i) => readStoredAction(a, i)) : [];
}

export function readStoredOptions(raw: unknown): FlowOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: FlowOptions = {};
  for (const key of ['timeoutMs', 'retries', 'retryDelayMs', 'maxDurationMs', 'maxConcurrentRuns'] as const) {
    if (typeof o[key] === 'number') out[key] = o[key] as number;
  }
  return out;
}

/** Actions for an API response: sensitive header values replaced by MASKED_VALUE. */
export function maskActions(actions: FlowAction[]): FlowAction[] {
  return actions.map((a) => {
    if (!a.headers) return a;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.headers)) {
      headers[k] = isSensitiveHeader(k) && v ? MASKED_VALUE : v;
    }
    return { ...a, headers };
  });
}

/** The effective limits for a step, after flow options and defaults. */
export function stepLimits(action: FlowAction, options: FlowOptions) {
  const clamp = (v: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, v));
  return {
    timeoutMs: clamp(action.timeoutMs ?? options.timeoutMs ?? FLOW_LIMITS.timeoutMs.default, FLOW_LIMITS.timeoutMs),
    retries: clamp(action.retries ?? options.retries ?? FLOW_LIMITS.retries.default, FLOW_LIMITS.retries),
    retryDelayMs: clamp(
      action.retryDelayMs ?? options.retryDelayMs ?? FLOW_LIMITS.retryDelayMs.default,
      FLOW_LIMITS.retryDelayMs,
    ),
  };
}

export function runDeadlineMs(options: FlowOptions): number {
  const v = options.maxDurationMs ?? FLOW_LIMITS.maxDurationMs.default;
  return Math.min(FLOW_LIMITS.maxDurationMs.max, Math.max(FLOW_LIMITS.maxDurationMs.min, v));
}
