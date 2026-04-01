import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

export const IMPORT_QUEUE = 'import';
export const EMAIL_QUEUE = 'email';
export const EXPORT_QUEUE = 'export';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('redis.url') || 'redis://localhost:6379';
        const url = new URL(redisUrl);
        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            password: url.password || undefined,
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: IMPORT_QUEUE },
      { name: EMAIL_QUEUE },
      { name: EXPORT_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
