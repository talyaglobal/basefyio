#!/usr/bin/env node
/**
 * basefyio external prober — the same six availability probes the platform
 * runs on itself, from a machine that does not share its fate, posted to
 * POST /api/platform-status/samples every 30 seconds.
 *
 * Env: PLATFORM_DOMAIN (e.g. basefyio.com), PROBE_TOKEN (PLATFORM_STATUS_PROBE_TOKEN),
 *      VANTAGE (a short name, e.g. hel1-ext), CANARY_ANON_KEY (optional: enables the
 *      keyed REST and realtime probes), CANARY_DB_URL (optional: postgres://… through
 *      the pooler with sslmode=require), STORAGE_PROBE_URL (optional).
 * No dependencies beyond Node 20 (fetch) and, for the database probe, the `pg` package.
 */
import { createRequire } from 'node:module';

const domain = (process.env.PLATFORM_DOMAIN || '').trim();
const token = (process.env.PROBE_TOKEN || '').trim();
const vantage = (process.env.VANTAGE || 'external').trim().slice(0, 40);
const anonKey = (process.env.CANARY_ANON_KEY || '').trim();
const dbUrl = (process.env.CANARY_DB_URL || '').trim();
const storageUrl = (process.env.STORAGE_PROBE_URL || '').trim();
const intervalMs = Number(process.env.INTERVAL_MS || 30_000);
const UA = `basefyio-status-probe/1.0 (+https://${domain}/status; ${vantage})`;

if (!domain || !token) {
  console.error('PLATFORM_DOMAIN and PROBE_TOKEN are required');
  process.exit(2);
}

function failure(started, err, timeoutMs) {
  const detail = err?.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : String(err?.message ?? err).slice(0, 200);
  return { ok: false, latencyMs: Date.now() - started, detail };
}

async function httpProbe(url, timeoutMs, headers = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, ...headers } });
    try {
      await res.arrayBuffer();
    } catch {}
    const latencyMs = Date.now() - started;
    const ok = res.status >= 200 && res.status < 300 && latencyMs <= timeoutMs;
    return { ok, latencyMs, statusCode: res.status, detail: ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return failure(started, err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

async function sseProbe(url, timeoutMs, headers = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/event-stream', ...headers } });
    if (!res.ok || !res.body) return { ok: false, latencyMs: Date.now() - started, statusCode: res.status, detail: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('event: ready')) {
        ctrl.abort();
        return { ok: true, latencyMs: Date.now() - started, statusCode: res.status };
      }
      if (buffer.length > 16_384) break;
    }
    return { ok: false, latencyMs: Date.now() - started, statusCode: res.status, detail: 'stream ended before the ready frame' };
  } catch (err) {
    return failure(started, err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

async function pgProbe(connectionString, timeoutMs) {
  const started = Date.now();
  let Pool;
  try {
    ({ Pool } = createRequire(import.meta.url)('pg'));
  } catch {
    return null;
  }
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
  try {
    await pool.query('select 1');
    const latencyMs = Date.now() - started;
    return { ok: latencyMs <= timeoutMs, latencyMs };
  } catch (err) {
    return failure(started, err, timeoutMs);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function runAll() {
  const keyed = anonKey ? { apikey: anonKey } : null;
  const tasks = [
    (async () => {
      const ready = await httpProbe(`https://api.${domain}/api/health/ready`, 3000);
      if (!ready.ok || !keyed) return { probe: 'api', ...ready };
      return { probe: 'api', ...(await httpProbe(`https://api.${domain}/api/rest/v1/slo_probe?select=id&limit=1`, 1000, keyed)) };
    })(),
    httpProbe(`https://app.${domain}/login`, 3000).then((r) => ({ probe: 'dashboard', ...r })),
    httpProbe(`https://auth.${domain}/realms/master/.well-known/openid-configuration`, 3000).then((r) => ({ probe: 'auth', ...r })),
    dbUrl ? pgProbe(dbUrl, 2000).then((r) => (r ? { probe: 'database', ...r } : null)) : Promise.resolve(null),
    storageUrl ? httpProbe(storageUrl, 3000).then((r) => ({ probe: 'storage', ...r })) : Promise.resolve(null),
    keyed ? sseProbe(`https://api.${domain}/api/realtime/v1/stream?channels=slo_probe`, 5000, keyed).then((r) => ({ probe: 'realtime', ...r })) : Promise.resolve(null),
  ];
  const settled = await Promise.allSettled(tasks);
  return settled.filter((s) => s.status === 'fulfilled' && s.value).map((s) => s.value);
}

async function post(samples) {
  const ts = new Date().toISOString();
  const res = await fetch(`https://api.${domain}/api/platform-status/samples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': UA },
    body: JSON.stringify({ vantage, samples: samples.map((s) => ({ ...s, ts })) }),
  });
  if (!res.ok) throw new Error(`samples endpoint answered ${res.status}`);
}

let backlog = [];
async function tick() {
  const samples = await runAll();
  const failed = samples.filter((s) => !s.ok).map((s) => `${s.probe}:${s.detail ?? ''}`);
  backlog.push(...samples);
  try {
    await post(backlog);
    console.log(`${new Date().toISOString()} posted ${backlog.length} sample(s)${failed.length ? ` failures: ${failed.join(', ')}` : ''}`);
    backlog = [];
  } catch (err) {
    // The platform may be the thing that is down: keep up to 10 minutes of samples and retry.
    if (backlog.length > 120) backlog = backlog.slice(-120);
    console.warn(`${new Date().toISOString()} post failed (${err.message}); ${backlog.length} sample(s) queued`);
  }
}

console.log(`external prober for ${domain} as "${vantage}", every ${intervalMs / 1000} s; canary ${anonKey ? 'keyed' : 'not configured'}`);
await tick();
setInterval(() => void tick(), intervalMs);
