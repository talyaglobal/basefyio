import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

export const IMPORT_QUEUE = 'import';
export const EMAIL_QUEUE = 'email';
export const EXPORT_QUEUE = 'export';
export const BILLING_QUEUE = 'billing';
/** Generic CSV/XLSX → table import (distinct from supabase-import, which is a
 *  whole-project Supabase migration). */
export const DATA_IMPORT_QUEUE = 'data-import';
/** Async pgvector embedding generation (semantic search, RAG, recommendations). */
export const EMBEDDING_QUEUE = 'embedding';
/** RAG document ingest/index jobs (chunk → embed → store). */
export const RAG_INDEX_QUEUE = 'rag-index';
/** Blueprint → application generation pipeline. */
export const BLUEPRINT_GENERATE_QUEUE = 'blueprint-generate';
/** Blueprint app flow execution (trigger → action pipeline). */
export const FLOW_QUEUE = 'flow-execute';

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
      { name: DATA_IMPORT_QUEUE },
      { name: EMBEDDING_QUEUE },
      { name: RAG_INDEX_QUEUE },
      { name: BLUEPRINT_GENERATE_QUEUE },
      { name: FLOW_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
