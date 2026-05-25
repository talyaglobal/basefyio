/**
 * Build an explicit AI-crawler policy for robots.txt.
 *
 * Leaving AI bots to a wildcard `User-agent: *` rule technically lets them in,
 * but an explicit per-bot policy is the GEO-correct signal: it states intent,
 * survives future tightening of the wildcard rule, and lets you allow live
 * `search` engines while opting out of `training` scrapers — or vice versa.
 */
import { AI_CRAWLERS } from './crawlers.js';
import type { AiCrawlerPolicyOptions, RobotsRule } from './types.js';

/**
 * Produce one {@link RobotsRule} per AI crawler, allowing or disallowing it
 * according to its purpose and the supplied options. Defaults to allowing all
 * (the right choice when you *want* to show up in AI answers).
 */
export function aiCrawlerRules(
  options: AiCrawlerPolicyOptions = {},
): RobotsRule[] {
  const {
    allowSearch = true,
    allowUserActions = true,
    allowTraining = true,
    disallow = [],
  } = options;

  const allowFor = {
    search: allowSearch,
    'user-action': allowUserActions,
    training: allowTraining,
  } as const;

  return AI_CRAWLERS.map((crawler) => {
    const allowed = allowFor[crawler.purpose];
    if (allowed) {
      return {
        userAgent: crawler.token,
        allow: ['/'],
        ...(disallow.length ? { disallow } : {}),
      };
    }
    return { userAgent: crawler.token, disallow: ['/'] };
  });
}

/** Serialise {@link RobotsRule}s to robots.txt text. */
export function renderRobotsRules(rules: RobotsRule[]): string {
  const blocks = rules.map((rule) => {
    const lines = [`User-agent: ${rule.userAgent}`];
    for (const path of rule.allow ?? []) lines.push(`Allow: ${path}`);
    for (const path of rule.disallow ?? []) lines.push(`Disallow: ${path}`);
    return lines.join('\n');
  });
  return blocks.join('\n\n') + '\n';
}
