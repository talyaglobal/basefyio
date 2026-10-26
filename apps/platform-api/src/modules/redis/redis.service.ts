import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** The subset of commands durable state needs; bound to the durable client. */
export interface DurableCommands {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  incrby(key: string, value: number): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  keys(pattern: string): Promise<string[]>;
  getdel(key: string): Promise<string | null>;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;
  /**
   * Durable state — BullMQ bookkeeping, the cron-leader lease, usage counters
   * — goes to a second instance configured `noeviction` (`REDIS_QUEUE_URL`).
   * The cache instance runs `allkeys-lru`, which under memory pressure could
   * evict exactly the keys whose loss is not harmless. With one Redis
   * configured both names point at the same connection, as before.
   */
  private durableClient!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('redis.url') || 'redis://localhost:6379';
    this.client = new Redis(url);
    const queueUrl = this.config.get<string>('redis.queueUrl') || url;
    this.durableClient = queueUrl === url ? this.client : new Redis(queueUrl);
    this.logger.log(
      queueUrl === url
        ? 'Redis client connected (one instance for cache and durable state)'
        : 'Redis clients connected (cache and a separate durable instance)',
    );
  }

  onModuleDestroy() {
    this.client.disconnect();
    if (this.durableClient !== this.client) this.durableClient.disconnect();
  }

  /** The connection for state that must not be evicted. */
  getDurableClient(): Redis {
    return this.durableClient;
  }

  /** The same small command surface as this service, on the durable connection. */
  durable(): DurableCommands {
    const c = () => this.durableClient;
    return {
      get: (key) => c().get(key),
      set: async (key, value, ttlSeconds) => {
        await c().set(key, value, 'EX', ttlSeconds);
      },
      del: async (key) => {
        await c().del(key);
      },
      incr: (key) => c().incr(key),
      incrby: (key, value) => c().incrby(key, value),
      expire: async (key, seconds) => {
        await c().expire(key, seconds);
      },
      mget: (...keys) => c().mget(...keys),
      keys: (pattern) => c().keys(pattern),
      getdel: (key) => RedisService.getdelOn(c(), key),
    };
  }

  private static async getdelOn(client: Redis, key: string): Promise<string | null> {
    // GETDEL is atomic on Redis 6.2+; the script is the same thing for older servers.
    try {
      return await (client as any).getdel(key);
    } catch {
      const script = `
        local val = redis.call('GET', KEYS[1])
        if val then redis.call('DEL', KEYS[1]) end
        return val
      `;
      return (await client.eval(script, 1, key)) as string | null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async incrby(key: string, value: number): Promise<number> {
    return this.client.incrby(key, value);
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return this.client.mget(...keys);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async getdel(key: string): Promise<string | null> {
    // Use GETDEL for atomic get-and-delete (Redis 6.2+)
    // Falls back to Lua script if GETDEL is not available
    try {
      const val = await (this.client as any).getdel(key);
      return val;
    } catch {
      const script = `
        local val = redis.call('GET', KEYS[1])
        if val then redis.call('DEL', KEYS[1]) end
        return val
      `;
      const val = await this.client.eval(script, 1, key);
      return val as string | null;
    }
  }

  getClient(): Redis {
    return this.client;
  }

  /** True once the shared client has a live connection. */
  isReady(): boolean {
    return this.client?.status === 'ready';
  }

  /** Publish on a pub/sub channel; resolves to the number of receivers. */
  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  /**
   * A dedicated connection for SUBSCRIBE. A connection in subscriber mode can
   * run no other command, so it must never be the shared client.
   */
  createSubscriber(): Redis {
    if (!this.client) throw new Error('Redis client is not initialised yet');
    return this.client.duplicate();
  }
}
