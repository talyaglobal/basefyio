/**
 * Orphan RAG embedding cleanup sweep.
 *
 * Removes embedding_records (and their cascaded embeddings_store vectors) of
 * entity_type `rag_document_chunk` whose chunk no longer exists in rag_chunks —
 * left behind by a failed chunk-swap transaction or by a reindex that replaced
 * the previous chunks.
 *
 * Usage:
 *   ts-node --transpile-only scripts/rag-embedding-gc.ts --dry
 *   ts-node --transpile-only scripts/rag-embedding-gc.ts
 *   ts-node --transpile-only scripts/rag-embedding-gc.ts --project=<projectId>
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { RagEmbeddingGcService } from '../src/modules/rag/rag-embedding-gc.service';

async function main() {
  const dryRun = process.argv.includes('--dry');
  const projectArg = process.argv.find((a) => a.startsWith('--project='));
  const projectId = projectArg ? projectArg.split('=')[1] : undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const gc = app.get(RagEmbeddingGcService);
    if (dryRun) console.log('[DRY RUN] — no deletes will be performed');
    const result = await gc.sweep({ dryRun, projectId });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
