/**
 * Backfill script: index the last 90 days of sql_audit_logs into pgvector.
 *
 * Usage:
 *   ts-node --transpile-only scripts/backfill-embeddings.ts
 *   ts-node --transpile-only scripts/backfill-embeddings.ts --dry
 *   ts-node --transpile-only scripts/backfill-embeddings.ts --days=30
 *
 * Rate limit: 200ms between batches (~5 batches/sec, ~100 embeddings/sec).
 * OpenAI text-embedding-3-small Tier 1 limit: 3000 RPM — well within budget.
 */

import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 200;
const DEFAULT_DAYS = 90;
const MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

const isDry = process.argv.includes('--dry');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : DEFAULT_DAYS;

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY not set');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const openai = new OpenAI({ apiKey });

  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  console.log(`Backfilling sql_audit_logs since ${since.toISOString()} (${days} days)`);
  if (isDry) console.log('[DRY RUN] — no OpenAI calls or writes will be made');

  // Fetch all eligible logs (successful queries, non-trivial)
  const logs = await prisma.sqlAuditLog.findMany({
    where: {
      createdAt: { gte: since },
      error: null,
      query: { not: '' },
    },
    select: { id: true, query: true, projectId: true },
    orderBy: { createdAt: 'desc' },
  });

  const eligible = logs.filter((l) => l.query.trim().length > 20);
  console.log(`Found ${eligible.length} eligible logs (${logs.length} total, ${logs.length - eligible.length} skipped)`);

  if (isDry) {
    console.log('Dry run complete — no changes made');
    await prisma.$disconnect();
    return;
  }

  // Get project teamId mapping
  const projectIds = [...new Set(eligible.map((l) => l.projectId))];
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, teamId: true },
  });
  const projectTeamMap = new Map(projects.map((p) => [p.id, p.teamId]));

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);

    // Compute hashes and check which already exist
    const items = batch.map((log) => {
      const normalized = log.query
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000);
      const hash = crypto.createHash('sha256').update(normalized).digest('hex');
      return { log, normalized, hash };
    });

    const hashes = items.map((i) => i.hash);
    const existing = await prisma.embeddingRecord.findMany({
      where: { contentHash: { in: hashes } },
      select: { contentHash: true },
    });
    const existingHashes = new Set(existing.map((r) => r.contentHash));

    const toEmbed = items.filter((item) => !existingHashes.has(item.hash));
    skipped += items.length - toEmbed.length;

    if (toEmbed.length === 0) {
      processed += items.length;
      process.stdout.write(`\rProgress: ${processed}/${eligible.length} (${skipped} skipped, ${errors} errors)`);
      continue;
    }

    try {
      const response = await openai.embeddings.create({
        model: MODEL,
        input: toEmbed.map((i) => i.normalized),
      });

      for (let j = 0; j < toEmbed.length; j++) {
        const { log, normalized, hash } = toEmbed[j];
        const embedding = response.data[j].embedding;
        const teamId = projectTeamMap.get(log.projectId);

        try {
          const record = await prisma.embeddingRecord.upsert({
            where: { contentHash: hash },
            create: {
              contentHash: hash,
              entityType: 'sql_audit_log',
              entityId: log.id,
              projectId: log.projectId,
              teamId: teamId ?? null,
              embeddingModel: MODEL,
              tokenCount: Math.ceil(normalized.length / 4),
              metadata: { text: normalized.slice(0, 2000) },
            },
            update: {},
            select: { id: true },
          });

          const literal = `[${embedding.join(',')}]`;
          await prisma.$executeRawUnsafe(
            `INSERT INTO embeddings_store (id, embedding)
             VALUES ($1, $2::vector)
             ON CONFLICT (id) DO NOTHING`,
            record.id,
            literal,
          );
        } catch (writeErr: any) {
          errors++;
          console.error(`\nFailed to write embedding for ${log.id}: ${writeErr.message}`);
        }
      }

      processed += batch.length;
    } catch (apiErr: any) {
      errors += toEmbed.length;
      processed += items.length - toEmbed.length;
      console.error(`\nOpenAI batch error: ${apiErr.message}`);
    }

    process.stdout.write(`\rProgress: ${processed}/${eligible.length} (${skipped} skipped, ${errors} errors)`);

    // Rate limit: 200ms between batches
    if (i + BATCH_SIZE < eligible.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\nDone. ${processed} processed, ${skipped} skipped (already indexed), ${errors} errors`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
