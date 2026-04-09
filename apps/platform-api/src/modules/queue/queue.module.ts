import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

export const IMPORT_QUEUE = 'import';
export const EMAIL_QUEUE = 'email';
export const EXPORT_QUEUE = 'export';
export const BILLING_QUEUE = 'billing';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('redis.url') || 'redis://localhost:6379';
        const url = new URL(redisUrl);
        const isTls = url.protocol === 'rediss:';
        const db = (() => {
          const raw = url.pathname?.replace('/', '').trim();
          if (!raw) return undefined;
          const parsed = Number.parseInt(raw, 10);
          return Number.isNaN(parsed) ? undefined : parsed;
        })();

        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            username: url.username || undefined,
            password: url.password || undefined,
            db,
            ...(isTls ? { tls: {} } : {}),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            enableOfflineQueue: true,
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: IMPORT_QUEUE },
      { name: EMAIL_QUEUE },
      { name: EXPORT_QUEUE },
      { name: BILLING_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
