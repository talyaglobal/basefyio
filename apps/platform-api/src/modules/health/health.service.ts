import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DataEngineService } from '../data-engine/data-engine.service';
import { MESSAGE_BUS, MessageBus } from '../message-bus/message-bus.port';

export type CheckState = 'ok' | 'failing' | 'skipped';

export interface CheckResult {
  state: CheckState;
  latencyMs?: number;
  /** Why it failed, in one line; never the dependency's credentials or host. */
  detail?: string;
}

export interface DependencyChecks {
  database: CheckResult;
  redis: CheckResult;
  keycloak: CheckResult;
  storage: CheckResult;
  documentStore: CheckResult;
  bus: CheckResult;
}

/** A dependency that does not answer within this is reported as failing. */
const CHECK_TIMEOUT_MS = 1_000;

/**
 * The dependencies the API cannot serve without, each probed with a bounded
 * wait so a hung dependency can never hang the health route itself.
 *
 * Only the platform database decides readiness (see HealthController): Redis,
 * Keycloak or storage being down degrades the API, but pulling every replica
 * out of the load balancer for it would turn a partial outage into a total
 * one.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @Optional() private readonly dataEngine?: DataEngineService,
    @Optional() @Inject(MESSAGE_BUS) private readonly bus?: MessageBus,
  ) {}

  async database(): Promise<CheckResult> {
    return this.timed(async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }

  async redisCheck(): Promise<CheckResult> {
    return this.timed(async () => {
      const pong = await this.redis.getClient().ping();
      if (pong !== 'PONG') throw new Error(`unexpected reply ${String(pong)}`);
    });
  }

  async keycloak(): Promise<CheckResult> {
    const base = (this.config.get<string>('keycloak.url') || '').replace(/\/+$/, '');
    if (!base) return { state: 'skipped', detail: 'not configured' };
    // Keycloak 25+ serves health on the management port; KEYCLOAK_HEALTH_URL says where.
    const url = (this.config.get<string>('keycloak.healthUrl') || '').trim() || `${base}/health/ready`;
    return this.timed(() => this.expect200(url));
  }

  async storage(): Promise<CheckResult> {
    const endpoint = this.config.get<string>('minio.endpoint');
    if (!endpoint) return { state: 'skipped', detail: 'not configured' };
    const port = this.config.get<number>('minio.port') ?? 9000;
    const scheme = this.config.get<boolean>('minio.useSsl') ? 'https' : 'http';
    return this.timed(() => this.expect200(`${scheme}://${endpoint}:${port}/minio/health/live`));
  }

  async documentStore(): Promise<CheckResult> {
    if (!this.dataEngine) return { state: 'skipped', detail: 'no engine' };
    return this.timed(async () => {
      const ok = await this.dataEngine!.ping();
      if (!ok) throw new Error('ping returned false');
    });
  }

  /** The message bus: skipped when no broker is configured, failing when configured but not connected. */
  async busCheck(): Promise<CheckResult> {
    if (!this.bus || !this.bus.isEnabled()) return { state: 'skipped', detail: 'not configured' };
    return this.bus.isConnected() ? { state: 'ok' } : { state: 'failing', detail: 'not connected' };
  }

  /** Every check at once; the slowest bounds the whole call at the timeout. */
  async all(): Promise<DependencyChecks> {
    const [database, redis, keycloak, storage, documentStore, bus] = await Promise.all([
      this.database(),
      this.redisCheck(),
      this.keycloak(),
      this.storage(),
      this.documentStore(),
      this.busCheck(),
    ]);
    return { database, redis, keycloak, storage, documentStore, bus };
  }

  private async expect200(url: string): Promise<void> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { 'user-agent': 'basefyio-health/1' },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  }

  private async timed(probe: () => Promise<void>): Promise<CheckResult> {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([probe(), timeout]);
      return { state: 'ok', latencyMs: Date.now() - started };
    } catch (err: any) {
      const detail = String(err?.message ?? err).slice(0, 160);
      this.logger.debug(`Dependency check failed: ${detail}`);
      return { state: 'failing', latencyMs: Date.now() - started, detail };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
