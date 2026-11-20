/* eslint-disable no-console */
/**
 * Records who owns each existing physical bucket in storage_bucket_owners, so bucket access
 * stops depending on the ambiguous name (`bf-a-` + `b-x` = `bf-a-b-` + `x`).
 *
 * Usage (from apps/platform-api):
 *   npx ts-node --transpile-only scripts/backfill-bucket-owners.ts                 # dry run, read-only
 *   npx ts-node --transpile-only scripts/backfill-bucket-owners.ts --apply         # unambiguous + --assign
 *   npx ts-node --transpile-only scripts/backfill-bucket-owners.ts --apply --apply-dated
 *   npx ts-node --transpile-only scripts/backfill-bucket-owners.ts --apply --assign bf-a-b-x=<projectId>
 *   ... --json                                                                      # machine-readable plan
 *
 * Decisions (see src/modules/storage/bucket-owner-backfill.ts):
 *   unambiguous  one project prefix (any status) matches: recorded with --apply. The API would
 *                record it on first use anyway; running this first only saves that lookup.
 *   dated        several match, only one of those projects existed when the bucket was created:
 *                recorded only with --apply-dated (owner decision).
 *   assigned     --assign <physical>=<projectId>, the migration path for an ambiguous bucket. The
 *                project must be one whose prefix matches. Repeatable.
 *   ambiguous    refused to every project by the API until assigned; printed with the project the
 *                old listing showed it under.
 *   platform / orphan / recorded: left alone.
 *
 * Idempotent: rows are inserted with skipDuplicates and never overwritten. Nothing in MinIO is
 * changed. The dry run prints the count of overlapping project prefix pairs and of ambiguous
 * buckets, which is the customer impact of the strict ownership check.
 *
 * Env vars: DATABASE_URL, MINIO_* (or S3_* with STORAGE_DRIVER=s3), STORAGE_BUCKET_PREFIX.
 */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';
import configuration from '../src/config/configuration';
import { buildStorageClients } from '../src/modules/storage/storage-client.factory';
import { planBucketOwnerBackfill, rowsToWrite } from '../src/modules/storage/bucket-owner-backfill';

dotenv.config();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const applyDated = args.includes('--apply-dated');
const asJson = args.includes('--json');
const assignments = new Map<string, string>();
args.forEach((a, i) => {
  const value = a === '--assign' ? args[i + 1] : a.startsWith('--assign=') ? a.slice('--assign='.length) : null;
  if (!value) return;
  const [physical, projectId] = value.split('=');
  if (!physical || !projectId) {
    console.error(`Bad --assign "${value}", expected <physical>=<projectId>`);
    process.exit(2);
  }
  assignments.set(physical, projectId);
});
if (applyDated && !apply) {
  console.error('--apply-dated needs --apply');
  process.exit(2);
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const stores = buildStorageClients(new ConfigService(configuration()));
    const [buckets, projects, owners] = await Promise.all([
      stores.client.listBuckets(),
      prisma.project.findMany({ select: { id: true, slug: true, storagePrefix: true, status: true, createdAt: true } }),
      prisma.storageBucketOwner.findMany({ select: { physicalName: true, projectId: true } }),
    ]);
    const plan = planBucketOwnerBackfill({
      bucketPrefix: stores.bucketPrefix,
      buckets: buckets.map((b) => ({ name: b.name, creationDate: b.creationDate })),
      projects,
      owners: new Map(owners.map((o) => [o.physicalName, o.projectId])),
      assignments,
    });
    const rows = rowsToWrite(plan, { dated: applyDated });
    const count = (k: string) => plan.decisions.filter((d) => d.kind === k).length;

    if (asJson) {
      console.log(JSON.stringify({ ...plan, rowsToWrite: rows, apply, applyDated }, null, 2));
    } else {
      const slug = new Map(projects.map((p) => [p.id, `${p.storagePrefix ?? p.slug} (${p.id}, ${p.status})`]));
      console.log(`Store: ${stores.describe()}  bucket prefix "${stores.bucketPrefix}"`);
      console.log(`Buckets: ${buckets.length}  projects (any status): ${projects.length}  owner rows: ${owners.length}`);
      console.log(`Overlapping project prefix pairs: ${plan.overlappingPairs.length}`);
      for (const [a, b] of plan.overlappingPairs) console.log(`  ${slug.get(a)}  <->  ${slug.get(b)}`);
      console.log(
        `Decisions: recorded ${count('recorded')}, unambiguous ${count('unambiguous')}, dated ${count('dated')}, ` +
          `assigned ${count('assigned')}, ambiguous ${count('ambiguous')}, platform ${count('platform')}, orphan ${count('orphan')}`,
      );
      for (const d of plan.decisions) {
        if (d.kind === 'dated') console.log(`  dated      ${d.physical} -> ${slug.get(d.projectId)} (candidates ${d.candidates.join(', ')})`);
        if (d.kind === 'assigned') console.log(`  assigned   ${d.physical} -> ${slug.get(d.projectId)}`);
        if (d.kind === 'ambiguous') {
          console.log(
            `  AMBIGUOUS  ${d.physical} candidates ${d.candidates.map((c) => slug.get(c)).join(' | ')}; ` +
              `old listing showed it under ${d.listedUnder ? slug.get(d.listedUnder) : 'nobody'}`,
          );
        }
      }
      for (const r of plan.rejectedAssignments) console.log(`  --assign ${r.physical}=${r.projectId} ignored: ${r.reason}`);
    }

    if (!apply) {
      console.error(`Dry run: ${rows.length} row(s) would be written. Re-run with --apply to write them.`);
      return;
    }
    const res = await prisma.storageBucketOwner.createMany({ data: rows, skipDuplicates: true });
    console.error(`Wrote ${res.count} owner row(s) (${rows.length - res.count} already present).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
