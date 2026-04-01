import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('redis.url') || 'redis://localhost:6379';
    this.client = new Redis(url);
    this.logger.log('Redis client connected');
  }

  onModuleDestroy() {
    this.client.disconnect();
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
}
