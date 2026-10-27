import { PrismaClient } from '@prisma/client';
import { DEFAULT_PLANS } from '../src/modules/billing/default-plans';

const prisma = new PrismaClient();

// The plan rows live with the API, which also writes them on an empty database.
const plans = DEFAULT_PLANS;

async function main() {
  console.log('Seeding plans...');

  for (const plan of plans) {
    const data = { ...plan } as any;
    await prisma.plan.upsert({
      where: { name: plan.name },
      update: data,
      create: data,
    });
    console.log(`  ✓ Plan "${plan.displayName}" upserted`);
  }

  // Grandfather existing teams: assign Legacy plan + create subscription + usage
  const legacyPlan = await prisma.plan.findUnique({ where: { name: 'legacy' } });
  if (!legacyPlan) throw new Error('Legacy plan not found after seeding');

  const teamsWithoutSub = await prisma.team.findMany({
    where: { subscription: null },
    include: {
      members: true,
      projects: { where: { status: { not: 'DELETED' } } },
    },
  });

  console.log(`\nGrandfathering ${teamsWithoutSub.length} existing team(s)...`);

  for (const team of teamsWithoutSub) {
    await prisma.subscription.create({
      data: {
        teamId: team.id,
        planId: legacyPlan.id,
        status: 'ACTIVE',
      },
    });

    await prisma.teamUsage.create({
      data: {
        teamId: team.id,
        projectCount: team.projects.length,
        memberCount: team.members.length,
        storageBytes: BigInt(0),
        dbSizeBytes: BigInt(0),
        apiRequestsMonth: 0,
        bandwidthMonth: BigInt(0),
        mauCount: 0,
      },
    });

    console.log(`  ✓ Team "${team.name}" → Legacy plan (${team.projects.length} projects, ${team.members.length} members)`);
  }

  console.log('\nSeed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
