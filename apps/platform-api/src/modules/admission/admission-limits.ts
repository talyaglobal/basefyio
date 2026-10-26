import type { BucketLimits } from './token-bucket';

/**
 * Requests per second and burst per plan, until the owner sets real numbers
 * on the plan editor (`Plan.features.api_rps` / `api_burst` win when present).
 * Dedicated instances (WP-4) get their own ceiling.
 */
export const DEFAULT_PLAN_LIMITS: Record<string, BucketLimits> = {
  free: { rate: 50, burst: 100 },
  pro: { rate: 200, burst: 400 },
  business: { rate: 500, burst: 1000 },
  enterprise: { rate: 2000, burst: 4000 },
  dedicated: { rate: 2000, burst: 4000 },
};

export const FALLBACK_LIMITS: BucketLimits = DEFAULT_PLAN_LIMITS.free;

/** Dashboard sessions are bounded per user, generously: the console is not where load comes from. */
export const DASHBOARD_USER_LIMITS: BucketLimits = { rate: 100, burst: 300 };

function positive(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** The limits a plan grants: explicit feature values first, then the plan's default, then free. */
export function limitsForPlan(planName: string | null | undefined, features?: Record<string, unknown> | null): BucketLimits {
  const base = DEFAULT_PLAN_LIMITS[(planName ?? '').toLowerCase()] ?? FALLBACK_LIMITS;
  const rate = positive(features?.api_rps) ?? positive(features?.apiRps) ?? base.rate;
  const burst = positive(features?.api_burst) ?? positive(features?.apiBurst) ?? Math.max(rate, base.burst);
  return { rate, burst: Math.max(burst, rate) };
}

export type AdmissionMode = 'off' | 'log' | 'enforce';

export function admissionMode(): AdmissionMode {
  const v = (process.env.ADMISSION_MODE || 'log').trim().toLowerCase();
  return v === 'off' || v === 'enforce' ? v : 'log';
}

export interface AdmissionConfig {
  mode: AdmissionMode;
  maxInflight: number;
  maxWaiting: number;
  maxWaitMs: number;
  /** 0..1 share of the in-flight limit reserved for dashboard (JWT) traffic. */
  dashboardShare: number;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function admissionConfig(): AdmissionConfig {
  const sharePct = envInt('ADMISSION_DASHBOARD_SHARE', 30);
  return {
    mode: admissionMode(),
    maxInflight: envInt('ADMISSION_MAX_INFLIGHT', 200),
    maxWaiting: envInt('ADMISSION_MAX_WAITING', 400),
    maxWaitMs: envInt('ADMISSION_MAX_WAIT_MS', 1500),
    dashboardShare: Math.min(0.9, Math.max(0.05, sharePct / 100)),
  };
}
