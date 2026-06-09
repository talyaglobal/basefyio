/**
 * Drizzle schema barrel for the NEW tables only.
 *
 * Drizzle and Prisma coexist during this transition: Prisma continues to own all
 * existing tables; Drizzle owns only the tables exported here. The `_refs` module
 * declares Prisma-owned tables purely as foreign-key anchors and is intentionally
 * NOT re-exported, so drizzle-kit never tries to migrate them.
 */
export * from './rag';
export * from './agent-memory';
export * from './agent-creation';
