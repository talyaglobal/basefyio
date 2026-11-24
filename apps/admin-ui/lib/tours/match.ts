/**
 * Route matching for tours (eager, tiny). Type-only imports, so scripts/check-tours.js can
 * evaluate this file on its own and use the very same matcher as the app.
 */
import type { FeatureFlags } from '@/lib/types';
import type { TourRoute, TourWhen } from './types';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `[x]` is one segment, a trailing `/**` is "this path or anything below it". */
export function compilePattern(pattern: string): RegExp {
  const prefix = pattern.endsWith('/**');
  const base = prefix ? pattern.slice(0, -3) : pattern;
  const body = base
    .split('/')
    .map((seg) => (/^\[[^\]]+\]$/.test(seg) ? '[^/]+' : escapeRegExp(seg)))
    .join('/');
  return new RegExp(`^${body}${prefix ? '(?:/.*)?' : ''}/?$`);
}

/**
 * Specificity of a pattern, the way Next routes: per segment a static name beats a dynamic one,
 * which beats a catch-all; an exact pattern beats a prefix pattern of the same length.
 * Compare with `compareRank` (higher first).
 */
export function rankPattern(pattern: string): number[] {
  const prefix = pattern.endsWith('/**');
  const base = prefix ? pattern.slice(0, -3) : pattern;
  const segs = base.split('/').filter(Boolean);
  const rank: number[] = segs.map((seg) => (/^\[[^\]]+\]$/.test(seg) ? 2 : 3));
  rank.push(prefix ? 1 : 4);
  return rank;
}

export function compareRank(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return y - x;
  }
  return 0;
}

export function whenPasses(when: TourWhen | undefined, features: Partial<FeatureFlags>): boolean {
  if (!when) return true;
  if (when.flagOn && !features[when.flagOn]) return false;
  if (when.flagOff && features[when.flagOff]) return false;
  return true;
}

/** Rank of the best pattern of `route` that matches `pathname`, or null when none does. */
export function routeRank(route: TourRoute, pathname: string): number[] | null {
  if (route.except?.some((p) => compilePattern(p).test(pathname))) return null;
  let best: number[] | null = null;
  for (const p of route.routes) {
    if (!compilePattern(p).test(pathname)) continue;
    const r = rankPattern(p);
    if (!best || compareRank(r, best) < 0) best = r;
  }
  return best;
}

function pick(routes: TourRoute[], pathname: string, features: Partial<FeatureFlags>): TourRoute | null {
  let winner: TourRoute | null = null;
  let winnerRank: number[] | null = null;
  for (const route of routes) {
    if (!whenPasses(route.when, features)) continue;
    const r = routeRank(route, pathname);
    if (!r) continue;
    if (!winnerRank || compareRank(r, winnerRank) < 0) {
      winner = route;
      winnerRank = r;
    }
  }
  return winner;
}

/** The chrome tour and the page tour for a pathname (either may be null). */
export function matchTours(
  routes: TourRoute[],
  pathname: string,
  features: Partial<FeatureFlags>,
): { chrome: TourRoute | null; page: TourRoute | null } {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return {
    chrome: pick(routes.filter((r) => r.kind === 'chrome'), path, features),
    page: pick(routes.filter((r) => r.kind === 'page'), path, features),
  };
}

/**
 * The page tours that tie for the best rank on a pathname. More than one means the matcher
 * cannot decide between them; the build guard fails on that.
 */
export function topPageMatches(routes: TourRoute[], pathname: string): TourRoute[] {
  let top: number[] | null = null;
  let out: TourRoute[] = [];
  for (const r of routes) {
    if (r.kind !== 'page') continue;
    const rank = routeRank(r, pathname);
    if (!rank) continue;
    const c = top ? compareRank(rank, top) : -1;
    if (c < 0) {
      top = rank;
      out = [r];
    } else if (c === 0) {
      out.push(r);
    }
  }
  return out;
}
