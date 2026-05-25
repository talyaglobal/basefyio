/**
 * GEO audit engine: fetch a URL (page + robots.txt + llms.txt), run the rubric,
 * and produce a normalised 0–100 score with a letter grade and a prioritised
 * fix list. {@link auditInput} works on already-fetched data so it stays pure
 * and testable; {@link auditUrl} adds the network IO around it.
 */
import type {
  AuditInput,
  AuditReport,
  GeoGrade,
} from '../types.js';
import { runChecks } from './checks.js';

export { runChecks } from './checks.js';
export { extractPage } from './html.js';
export type { ExtractedPage } from './html.js';

function gradeFor(score: number): GeoGrade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** Score pre-fetched inputs. No network. */
export function auditInput(input: AuditInput): AuditReport {
  const categories = runChecks(input);
  const total = categories.reduce((s, c) => s + c.score, 0);
  const max = categories.reduce((s, c) => s + c.max, 0);
  const score = max > 0 ? Math.round((total / max) * 100) : 0;

  // Recommendations: failing/warning checks ordered by points recoverable.
  const recommendations = categories
    .flatMap((c) => c.checks)
    .filter((c) => c.status !== 'pass' && c.fix)
    .sort((a, b) => b.max - b.score - (a.max - a.score))
    .map((c) => c.fix!);

  return {
    url: input.url,
    fetchedAt: new Date().toISOString(),
    score,
    grade: gradeFor(score),
    categories,
    recommendations,
  };
}

async function tryFetch(url: string): Promise<{ ok: boolean; text: string }> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'kolaybase-geo-audit/0.1 (+https://kolaybase.com)' },
    });
    const text = res.ok ? await res.text() : '';
    return { ok: res.ok, text };
  } catch {
    return { ok: false, text: '' };
  }
}

export interface AuditUrlOptions {
  /** Override fetch (for tests or custom transports). */
  fetchImpl?: typeof fetch;
}

/** Fetch everything the audit needs for `url`, then score it. */
export async function auditUrl(url: string): Promise<AuditReport> {
  const origin = new URL(url).origin;

  const [page, robots, llms] = await Promise.all([
    tryFetch(url),
    tryFetch(`${origin}/robots.txt`),
    tryFetch(`${origin}/llms.txt`),
  ]);

  if (!page.ok && !page.text) {
    throw new Error(`Could not fetch ${url}`);
  }

  return auditInput({
    url,
    html: page.text,
    robotsTxt: robots.ok ? robots.text : null,
    hasLlmsTxt: llms.ok,
    llmsTxt: llms.ok ? llms.text : null,
  });
}
