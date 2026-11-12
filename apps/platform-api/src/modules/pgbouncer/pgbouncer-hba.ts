import { isIP } from 'net';

/**
 * External database access rules, written as PgBouncer's host-based
 * authentication file (`auth_type = hba`). Pure functions so the exact file
 * can be tested line by line.
 */

/** Most entries one project's allow list may hold. */
export const MAX_ALLOWED_CIDRS = 50;

export type CidrCheck =
  | { ok: true; value: string; family: 4 | 6 }
  | { ok: false; input: string; message: string };

function parseIPv4(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v;
}

function formatIPv4(v: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(v / 2 ** shift) % 256).join('.');
}

function parseIPv6(addr: string): bigint | null {
  let a = addr.toLowerCase();
  // An embedded IPv4 tail (::ffff:192.0.2.1) becomes two hex groups.
  const lastColon = a.lastIndexOf(':');
  const tail = a.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    a = `${a.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const rest = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

/** RFC 5952 text form: lower case, no leading zeros, the longest run of zero groups as `::`. */
function formatIPv6(v: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i -= 1) {
    groups.push(Number((v >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j += 1;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLen).join(':')}`;
}

/**
 * One allow-list entry, normalised to the network it names: a bare address
 * becomes a single-host block (/32 or /128) and host bits are cleared
 * (`203.0.113.7/24` → `203.0.113.0/24`), so what is stored is exactly what the
 * pooler matches. A /0 block is refused — it lets every address in, which is
 * what switching the list off already does.
 */
export function normalizeCidr(input: unknown): CidrCheck {
  const raw = typeof input === 'string' ? input.trim() : '';
  const fail = (message: string): CidrCheck => ({ ok: false, input: raw, message });
  if (!raw) return fail('Enter an IP address or a range such as 203.0.113.0/24.');

  const slash = raw.indexOf('/');
  if (slash !== raw.lastIndexOf('/')) return fail(`"${raw}" is not an IP address or range.`);
  const addr = slash === -1 ? raw : raw.slice(0, slash);
  const prefixText = slash === -1 ? null : raw.slice(slash + 1);

  const family = isIP(addr);
  if (family !== 4 && family !== 6) return fail(`"${raw}" is not an IP address or range.`);
  const max = family === 4 ? 32 : 128;

  let prefix = max;
  if (prefixText !== null) {
    if (!/^\d{1,3}$/.test(prefixText)) return fail(`"${raw}" has an invalid prefix length.`);
    prefix = Number(prefixText);
    if (prefix > max) return fail(`"${raw}" has a prefix longer than /${max}.`);
  }
  if (prefix === 0) {
    return fail(`"${raw}" would let every address in. Turn the allow list off instead.`);
  }

  if (family === 4) {
    const v = parseIPv4(addr);
    if (v === null) return fail(`"${raw}" is not an IP address or range.`);
    const size = 2 ** (32 - prefix);
    const network = Math.floor(v / size) * size;
    return { ok: true, value: `${formatIPv4(network)}/${prefix}`, family: 4 };
  }

  const v = parseIPv6(addr);
  if (v === null) return fail(`"${raw}" is not an IP address or range.`);
  const hostBits = BigInt(128 - prefix);
  const network = (v >> hostBits) << hostBits;
  return { ok: true, value: `${formatIPv6(network)}/${prefix}`, family: 6 };
}

/**
 * A whole allow list: every entry normalised, duplicates removed, order kept.
 * Fails on the first bad entry so the person sees which one to fix.
 */
export function normalizeCidrList(
  input: unknown,
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (!Array.isArray(input)) return { ok: false, message: 'The allow list must be a list of addresses.' };
  const out: string[] = [];
  for (const entry of input) {
    const r = normalizeCidr(entry);
    if (!r.ok) return { ok: false, message: r.message };
    if (!out.includes(r.value)) out.push(r.value);
  }
  if (out.length > MAX_ALLOWED_CIDRS) {
    return { ok: false, message: `An allow list can hold at most ${MAX_ALLOWED_CIDRS} entries.` };
  }
  return { ok: true, value: out };
}

/** What the HBA writer needs about one project with rules. */
export interface HbaProjectRule {
  dbName: string;
  requireTls: boolean;
  allowedCidrs: string[];
}

/** Whether a policy restricts anything at all. */
export function hasRestrictions(p: { requireTls?: boolean | null; allowedCidrs?: string[] | null } | null | undefined): boolean {
  return !!p && (p.requireTls === true || (p.allowedCidrs?.length ?? 0) > 0);
}

/**
 * Database names go into the file unquoted. Every name the platform allocates
 * (`kb_<hex>`, older `kb_<slug>`) fits this; anything else is left out of the
 * per-project rules and reported, never written half-escaped.
 */
export function isHbaSafeName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && name !== 'all' && name !== 'sameuser' && name !== 'replication';
}

/**
 * The method for every allowed line. `password` is PgBouncer's name for the
 * cleartext exchange that `auth_type = plain` used, so a database without
 * rules authenticates exactly as it always has.
 */
const METHOD = 'password';

/**
 * The HBA file. First match wins, so each restricted database gets its allow
 * lines followed by a reject for everything else, and the closing lines admit
 * every other database from anywhere — the behaviour without rules.
 *
 * `tlsAvailable` false with a project that requires TLS: its `hostssl` lines
 * can never match, so that database refuses every external connection. That is
 * deliberate — failing open would hand out plaintext access the owner turned
 * off — and the caller logs it loudly.
 */
export function buildHbaFile(rules: HbaProjectRule[]): string {
  const lines: string[] = [
    '# Generated by basefyio. Do not edit: rewritten whenever the pooler config changes.',
    '# Per-database rules come first (first match wins); the last lines admit every',
    '# other database from any address, exactly as before rules existed.',
    '',
  ];

  for (const rule of rules) {
    if (!isHbaSafeName(rule.dbName) || !hasRestrictions(rule)) continue;
    const type = rule.requireTls ? 'hostssl' : 'host';
    const sources = rule.allowedCidrs.length ? rule.allowedCidrs : ['0.0.0.0/0', '::/0'];
    const summary = [
      rule.requireTls ? 'TLS required' : null,
      rule.allowedCidrs.length ? `allowed: ${rule.allowedCidrs.join(', ')}` : 'any address',
    ]
      .filter(Boolean)
      .join('; ');
    lines.push(`# ${rule.dbName}: ${summary}`);
    for (const cidr of sources) lines.push(`${type} ${rule.dbName} all ${cidr} ${METHOD}`);
    lines.push(`host ${rule.dbName} all 0.0.0.0/0 reject`);
    lines.push(`host ${rule.dbName} all ::/0 reject`);
    lines.push('');
  }

  lines.push('# Every other database');
  lines.push(`host all all 0.0.0.0/0 ${METHOD}`);
  lines.push(`host all all ::/0 ${METHOD}`);
  lines.push(`local all all ${METHOD}`);
  return lines.join('\n') + '\n';
}
