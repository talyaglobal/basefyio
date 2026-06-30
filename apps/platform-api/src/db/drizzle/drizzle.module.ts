import { Global, Module } from '@nestjs/common';
import { createDrizzle, type DrizzleDb } from './client';

/** Injection token for the Drizzle database handle (new tables only). */
export const DRIZZLE = Symbol('DRIZZLE_DB');

/**
 * Provides the Drizzle handle globally. Uses the same DATABASE_URL as Prisma —
 * one Postgres instance, two ORMs during the transition. Prisma keeps ownership
 * of all existing tables; Drizzle is used only for the new RAG/agent tables.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: (): DrizzleDb => {
        const url = process.env.DATABASE_URL;
        if (!url) {
          throw new Error('DATABASE_URL is required to initialise Drizzle');
        }
        return createDrizzle(url);
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule {}
