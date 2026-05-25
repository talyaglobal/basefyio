/**
 * Minimal robots.txt evaluation, just enough to answer one GEO question:
 * "is this AI crawler allowed to fetch `/`?"
 *
 * Implements the precedence rules that matter here: the most specific (longest)
 * matching path rule wins, and an explicit per-agent group overrides the
 * `User-agent: *` group. Not a full RFC 9309 implementation — it intentionally
 * only models root-path access.
 */

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

function parseGroups(robotsTxt: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      current.rules.push({ allow: field === 'allow', path: value });
      lastWasAgent = false;
    }
  }
  return groups;
}

function groupFor(groups: Group[], token: string): Group | undefined {
  const t = token.toLowerCase();
  return (
    groups.find((g) => g.agents.includes(t)) ??
    groups.find((g) => g.agents.includes('*'))
  );
}

export type RobotsVerdict = 'allowed' | 'disallowed' | 'unspecified';

/** Decide whether `token` may fetch `/` given the robots.txt body. */
export function evaluateRoot(
  robotsTxt: string | null | undefined,
  token: string,
): RobotsVerdict {
  if (!robotsTxt) return 'unspecified';
  const groups = parseGroups(robotsTxt);
  const group = groupFor(groups, token);
  if (!group || group.rules.length === 0) return 'unspecified';

  // Longest matching path wins; tie goes to Allow.
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of group.rules) {
    const path = rule.path === '' ? '/' : rule.path;
    if (!'/'.startsWith(path) && !path.startsWith('/')) continue;
    if ('/'.startsWith(path) || path === '/') {
      const len = path.length;
      if (!best || len > best.len || (len === best.len && rule.allow)) {
        best = { allow: rule.allow, len };
      }
    }
  }
  if (!best) return 'unspecified';
  return best.allow ? 'allowed' : 'disallowed';
}

/** True if the token has its own (non-wildcard) group in the file. */
export function hasExplicitGroup(
  robotsTxt: string | null | undefined,
  token: string,
): boolean {
  if (!robotsTxt) return false;
  const t = token.toLowerCase();
  return parseGroups(robotsTxt).some((g) => g.agents.includes(t));
}
