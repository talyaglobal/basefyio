import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Logger } from '@nestjs/common';
import type { JwtPayload } from '../decorators/current-user.decorator';

/**
 * Short-lived, single-use tickets for server-sent event streams.
 *
 * A browser's EventSource cannot send an Authorization header, so the
 * dashboard used to put the user's access token in the stream URL, where it
 * lands in proxy logs and server logs. A ticket replaces it: minted with a
 * normal authenticated request, bound to one stream path, valid for a minute
 * and accepted once. A ticket that leaks through a log is already spent.
 *
 * Tickets are signed, not stored, so any API replica can check one. Each
 * replica remembers the tickets it has accepted until they expire.
 */

export const STREAM_TICKET_TTL_MS = 60_000;

/** Only event-stream routes accept tickets; every other route still needs a bearer token. */
const STREAM_PATH = /^\/api\/(realtime\/stream|projects\/[^?#]+\/events)$/;

export function isStreamPath(path: string): boolean {
  return STREAM_PATH.test(path);
}

const logger = new Logger('StreamTicket');
let cachedKey: Buffer | null = null;

function signingKey(): Buffer {
  if (cachedKey) return cachedKey;
  const explicit = process.env.STREAM_TICKET_SECRET?.trim();
  // Fall back to a key derived from a secret every deployment already has, so
  // replicas agree without new configuration.
  const base =
    explicit ||
    process.env.DB_CRED_ENC_KEY?.trim() ||
    process.env.KEYCLOAK_ADMIN_PASSWORD?.trim() ||
    process.env.POSTGRES_PASSWORD?.trim();
  if (base) {
    cachedKey = createHash('sha256').update(`basefyio-stream-ticket:${base}`).digest();
  } else {
    logger.warn('No STREAM_TICKET_SECRET or derivable secret; stream tickets are valid on this process only');
    cachedKey = randomBytes(32);
  }
  return cachedKey;
}

/** For tests: forget the derived key so a changed environment is picked up. */
export function resetStreamTicketKeyForTests() {
  cachedKey = null;
  spent.clear();
}

const b64 = (b: Buffer) => b.toString('base64url');

function sign(body: string): string {
  return b64(createHmac('sha256', signingKey()).update(body).digest());
}

interface TicketBody {
  /** user */
  u: string;
  e: string;
  pu: string;
  r: string[];
  /** stream path */
  p: string;
  /** expiry, epoch ms */
  x: number;
  /** nonce */
  n: string;
}

export function issueStreamTicket(
  user: Pick<JwtPayload, 'sub' | 'email' | 'preferred_username' | 'roles'>,
  path: string,
  now = Date.now(),
): { ticket: string; expiresIn: number } {
  const body: TicketBody = {
    u: user.sub,
    e: user.email || '',
    pu: user.preferred_username || '',
    r: Array.isArray(user.roles) ? user.roles.slice(0, 20) : [],
    p: path,
    x: now + STREAM_TICKET_TTL_MS,
    n: randomBytes(12).toString('base64url'),
  };
  const encoded = b64(Buffer.from(JSON.stringify(body)));
  return { ticket: `${encoded}.${sign(encoded)}`, expiresIn: STREAM_TICKET_TTL_MS / 1000 };
}

/** Nonces accepted on this replica, kept until their ticket would have expired anyway. */
const spent = new Map<string, number>();

function sweep(now: number) {
  if (spent.size < 1000) return;
  for (const [n, exp] of spent) if (exp <= now) spent.delete(n);
}

/**
 * The user a ticket stands for, or null when it is forged, expired, meant for
 * another stream, or already used.
 */
export function redeemStreamTicket(ticket: string, path: string, now = Date.now()): JwtPayload | null {
  if (typeof ticket !== 'string' || ticket.length > 4096) return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  const encoded = ticket.slice(0, dot);
  const given = Buffer.from(ticket.slice(dot + 1));
  const expected = Buffer.from(sign(encoded));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let body: TicketBody;
  try {
    body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body.u !== 'string' || !body.u) return null;
  if (typeof body.x !== 'number' || body.x <= now) return null;
  if (body.p !== path) return null;
  if (spent.has(body.n)) return null;
  spent.set(body.n, body.x);
  sweep(now);

  return {
    sub: body.u,
    email: body.e,
    preferred_username: body.pu,
    roles: Array.isArray(body.r) ? body.r : [],
  };
}
