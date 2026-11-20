import configuration from './configuration';
import {
  redactUrl,
  redisConnectionOptions,
  resolveMessageBusUrl,
  resolveRedisUrls,
  withCredentials,
} from './connection-urls';

describe('withCredentials', () => {
  it('fills a password into a URL that has none', () => {
    expect(withCredentials('redis://redis:6379', 's3cret')).toBe('redis://:s3cret@redis:6379');
  });

  it('leaves a URL that already carries a password exactly as given', () => {
    expect(withCredentials('redis://:mine@redis:6379', 'other')).toBe('redis://:mine@redis:6379');
    expect(withCredentials('amqp://u:p@rabbitmq:5672', 'x', 'y')).toBe('amqp://u:p@rabbitmq:5672');
  });

  it('changes nothing without a password (an install that sets none of the new variables)', () => {
    expect(withCredentials('redis://redis:6379', '')).toBe('redis://redis:6379');
    expect(withCredentials('redis://redis:6379', undefined)).toBe('redis://redis:6379');
    expect(withCredentials('redis://redis:6379', '   ')).toBe('redis://redis:6379');
  });

  it('percent-encodes reserved characters so the URL still parses', () => {
    const url = withCredentials('redis://redis:6379/2', 'p@ss:w/rd#?%', 'us er');
    expect(redisConnectionOptions(url)).toEqual({
      host: 'redis',
      port: 6379,
      username: 'us er',
      password: 'p@ss:w/rd#?%',
      db: 2,
    });
  });

  it('refuses a URL it cannot parse, without echoing a password', () => {
    expect(() => withCredentials('not a url', 'pw')).toThrow(/not a valid connection URL/);
  });
});

describe('resolveRedisUrls', () => {
  it('defaults to a local Redis without a password', () => {
    expect(resolveRedisUrls({})).toEqual({ url: 'redis://localhost:6379', queueUrl: 'redis://localhost:6379' });
  });

  it('gives each instance its own password', () => {
    expect(
      resolveRedisUrls({
        REDIS_URL: 'redis://redis:6379',
        REDIS_PASSWORD: 'cache-pw',
        REDIS_QUEUE_URL: 'redis://redis-queue:6379',
        REDIS_QUEUE_PASSWORD: 'queue-pw',
      }),
    ).toEqual({ url: 'redis://:cache-pw@redis:6379', queueUrl: 'redis://:queue-pw@redis-queue:6379' });
  });

  it('shares the cache instance, and its password, when no queue URL is set', () => {
    const urls = resolveRedisUrls({ REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'pw', REDIS_QUEUE_PASSWORD: 'ignored' });
    expect(urls.queueUrl).toBe(urls.url);
    expect(urls.url).toBe('redis://:pw@redis:6379');
  });

  it('never borrows the cache password for a separate queue instance', () => {
    expect(
      resolveRedisUrls({ REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'pw', REDIS_QUEUE_URL: 'redis://redis-queue:6379' })
        .queueUrl,
    ).toBe('redis://redis-queue:6379');
  });

  it('keeps TLS and the db index through to the BullMQ options', () => {
    const { queueUrl } = resolveRedisUrls({ REDIS_QUEUE_URL: 'rediss://q.example:6380/3', REDIS_QUEUE_PASSWORD: 'pw' });
    expect(redisConnectionOptions(queueUrl)).toEqual({
      host: 'q.example',
      port: 6380,
      username: undefined,
      password: 'pw',
      db: 3,
      tls: {},
    });
  });
});

describe('resolveMessageBusUrl', () => {
  it('stays empty (bus inert) when MESSAGE_BUS_URL is unset, whatever the credentials', () => {
    expect(resolveMessageBusUrl({ RABBITMQ_USER: 'u', RABBITMQ_PASSWORD: 'p' })).toBe('');
  });

  it('fills RABBITMQ_USER / RABBITMQ_PASSWORD into a URL without credentials', () => {
    expect(
      resolveMessageBusUrl({ MESSAGE_BUS_URL: 'amqp://rabbitmq:5672', RABBITMQ_USER: 'basefyio', RABBITMQ_PASSWORD: 'b!g s3cret' }),
    ).toBe('amqp://basefyio:b!g%20s3cret@rabbitmq:5672');
  });

  it('keeps a hand-written URL with credentials as it is', () => {
    expect(
      resolveMessageBusUrl({ MESSAGE_BUS_URL: 'amqp://a:b@rabbitmq:5672', RABBITMQ_USER: 'x', RABBITMQ_PASSWORD: 'y' }),
    ).toBe('amqp://a:b@rabbitmq:5672');
  });
});

describe('redactUrl', () => {
  it('hides the password', () => {
    expect(redactUrl('redis://:secret@redis:6379')).toBe('redis://:***@redis:6379');
    expect(redactUrl('amqp://u:secret@rabbitmq:5672')).toBe('amqp://u:***@rabbitmq:5672');
    expect(redactUrl('redis://redis:6379')).toBe('redis://redis:6379');
  });
});

describe('configuration() with the new variables', () => {
  const KEYS = [
    'REDIS_URL',
    'REDIS_PASSWORD',
    'REDIS_QUEUE_URL',
    'REDIS_QUEUE_PASSWORD',
    'MESSAGE_BUS_URL',
    'RABBITMQ_USER',
    'RABBITMQ_PASSWORD',
    'DOCKER_HOST',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => KEYS.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])));
  afterEach(() =>
    KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))),
  );

  it('is what the services read (redis.url, redis.queueUrl, messageBus.url, docker.host)', () => {
    Object.assign(process.env, {
      REDIS_URL: 'redis://redis:6379',
      REDIS_PASSWORD: 'a',
      REDIS_QUEUE_URL: 'redis://redis-queue:6379',
      REDIS_QUEUE_PASSWORD: 'b',
      MESSAGE_BUS_URL: 'amqp://rabbitmq:5672',
      RABBITMQ_USER: 'basefyio',
      RABBITMQ_PASSWORD: 'c',
      DOCKER_HOST: 'tcp://docker-proxy:2375',
    });
    const cfg = configuration();
    expect(cfg.redis).toEqual({ url: 'redis://:a@redis:6379', queueUrl: 'redis://:b@redis-queue:6379' });
    expect(cfg.messageBus.url).toBe('amqp://basefyio:c@rabbitmq:5672');
    expect(cfg.docker.host).toBe('tcp://docker-proxy:2375');
  });

  it('is unchanged for an install that sets none of them', () => {
    process.env.REDIS_URL = 'redis://redis:6379';
    const cfg = configuration();
    expect(cfg.redis).toEqual({ url: 'redis://redis:6379', queueUrl: 'redis://redis:6379' });
    expect(cfg.messageBus.url).toBe('');
    expect(cfg.docker.host).toBe('');
    expect(cfg.docker.socketPath).toBe(process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock');
  });
});
