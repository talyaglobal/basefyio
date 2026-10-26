import { VectorStoreService } from './vector-store.service';

/**
 * The vector table is raw SQL (Prisma has no vector column type), so a
 * deployment that applies schema.prisma with `db push` never creates it and
 * every embedding fails to persist. The service now creates what is missing
 * at boot, idempotently, and never lets that step take the process down.
 */
describe('VectorStoreService.ensureStore', () => {
  it('creates the extension, the table and the index with IF NOT EXISTS', async () => {
    const statements: string[] = [];
    const prisma = { $executeRawUnsafe: jest.fn(async (sql: string) => void statements.push(sql)) };
    const svc = new VectorStoreService(prisma as any);

    await svc.onModuleInit();

    expect(statements.join('\n')).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
    expect(statements.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS "embeddings_store"/);
    expect(statements.join('\n')).toMatch(/CREATE INDEX IF NOT EXISTS "embeddings_store_hnsw_idx"/);
    expect(statements.join('\n')).toMatch(/vector\(1536\)/);
  });

  it('survives a database that refuses the DDL', async () => {
    const prisma = { $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('permission denied')) };
    const svc = new VectorStoreService(prisma as any);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});
