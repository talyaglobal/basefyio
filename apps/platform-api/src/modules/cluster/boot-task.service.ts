import { Injectable, Logger } from '@nestjs/common';
import { hostname } from 'os';
import { randomBytes } from 'crypto';
import { RedisService } from '../redis/redis.service';

/** How long a claimed boot task keeps its siblings from repeating it. */
const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;

/**
 * Work that should happen once when the platform starts, not once per
 * replica: reconciling Docker resources, repairing realm references, failing
 * jobs a dead process left behind. The cron leader is elected after boot, so
 * it cannot be asked at boot; instead the first process to reach a task
 * claims it in the durable Redis for a few minutes and the others skip it.
 *
 * With Redis unreachable every process runs the task, which is exactly what
 * happened before this existed.
 */
@Injectable()
export class BootTaskService {
  private readonly logger = new Logger(BootTaskService.name);
  private readonly instanceId = `${hostname()}-${randomBytes(3).toString('hex')}`;

  constructor(private readonly redis: RedisService) {}

  /** True when this process should run the task. */
  async claim(task: string, ttlMs = DEFAULT_CLAIM_TTL_MS): Promise<boolean> {
    const key = `basefyio:boot:${task}`;
    try {
      const res = await this.redis.getDurableClient().set(key, this.instanceId, 'PX', ttlMs, 'NX');
      if (res === 'OK') return true;
      this.logger.log(`Boot task "${task}" already claimed by a sibling; skipping here`);
      return false;
    } catch (err: any) {
      this.logger.warn(`Boot task "${task}" claim unavailable (${err?.message ?? err}); running here`);
      return true;
    }
  }
}
