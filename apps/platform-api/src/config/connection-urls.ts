/**
 * Connection URLs for the internal services, with credentials that come from
 * their own variables.
 *
 * Redis and RabbitMQ used to be reached without a credential (Redis) or with a
 * published default (RabbitMQ). The compose files now start them with
 * `REDIS_PASSWORD`, `REDIS_QUEUE_PASSWORD` and `RABBITMQ_USER` /
 * `RABBITMQ_PASSWORD`; the API puts the same values into the URLs it already
 * reads. A URL that already carries a password is used exactly as given, so an
 * operator who writes the full URL by hand keeps full control, and an install
 * that sets none of the new variables behaves exactly as before.
 */

type Env = Record<string, string | undefined>;

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

function clean(v: string | undefined | null): string {
  return (v ?? '').trim();
}

/**
 * `rawUrl` with `password` (and `username`, when given) filled in, unless the
 * URL already names a password. The values are percent-encoded, so any
 * character is safe; every client used here (ioredis, amqplib) decodes them.
 */
export function withCredentials(rawUrl: string, password?: string | null, username?: string | null): string {
  const pass = clean(password);
  if (!rawUrl || !pass) return rawUrl;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${redactUrl(rawUrl)}" is not a valid connection URL`);
  }
  if (url.password) return rawUrl;
  const user = clean(username);
  if (user && !url.username) url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(pass);
  return url.toString();
}

export interface RedisUrls {
  /** Cache, rate limits, realtime fan-out (`redis`). */
  url: string;
  /** Durable state: BullMQ, the cron-leader lease, usage counters (`redis-queue`). */
  queueUrl: string;
}

/**
 * REDIS_URL + REDIS_PASSWORD for the cache instance; REDIS_QUEUE_URL +
 * REDIS_QUEUE_PASSWORD for the durable one. Without REDIS_QUEUE_URL the durable
 * state shares the cache instance, and therefore its password.
 */
export function resolveRedisUrls(env: Env = process.env): RedisUrls {
  const url = withCredentials(clean(env.REDIS_URL) || DEFAULT_REDIS_URL, env.REDIS_PASSWORD);
  const rawQueue = clean(env.REDIS_QUEUE_URL);
  const queueUrl = rawQueue ? withCredentials(rawQueue, env.REDIS_QUEUE_PASSWORD) : url;
  return { url, queueUrl };
}

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

/**
 * Discrete ioredis options from a redis:// or rediss:// URL — what BullMQ is
 * given. WHATWG URL keeps credentials percent-encoded, so they are decoded
 * here; passing the encoded form would fail AUTH for any password with a
 * reserved character.
 */
export function redisConnectionOptions(rawUrl: string): RedisConnectionOptions {
  const url = new URL(rawUrl || DEFAULT_REDIS_URL);
  const rawDb = url.pathname?.replace('/', '').trim();
  const parsedDb = rawDb ? Number.parseInt(rawDb, 10) : NaN;
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number.isNaN(parsedDb) ? undefined : parsedDb,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

/**
 * MESSAGE_BUS_URL stays the on/off switch: empty keeps the bus inert. When it
 * names no credentials (`amqp://rabbitmq:5672`), RABBITMQ_USER and
 * RABBITMQ_PASSWORD are filled in, so the secret lives in one variable only.
 */
export function resolveMessageBusUrl(env: Env = process.env): string {
  const raw = clean(env.MESSAGE_BUS_URL);
  if (!raw) return '';
  return withCredentials(raw, env.RABBITMQ_PASSWORD, env.RABBITMQ_USER);
}

/** The URL with its password replaced, for logs and error messages. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return rawUrl.replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:***@');
  }
}
