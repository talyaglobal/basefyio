import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

const plans = [
  {
    name: 'legacy',
    displayName: 'Legacy',
    maxProjects: null,
    maxStorageBytes: null,
    maxTeamMembers: null,
    maxDbSizeBytes: null,
    maxApiRequests: null,
    maxBandwidthBytes: null,
    maxMau: null,
    dedicatedDb: false,
    dedicatedStorage: false,
    dbMemoryMb: 0,
    dbCpuMillis: 0,
    priceMonthly: 0,
    stripePriceId: null,
    stripeProductId: null,
    isPublic: false,
    features: { grandfathered: true },
  },
  {
    name: 'free',
    displayName: 'Free',
    maxProjects: 5,
    maxStorageBytes: BigInt(2 * GB),
    maxTeamMembers: 3,
    maxDbSizeBytes: BigInt(1 * GB),
    maxApiRequests: 500_000,
    maxBandwidthBytes: BigInt(2 * GB),
    maxMau: 50_000,
    dedicatedDb: false,
    dedicatedStorage: false,
    dbMemoryMb: 0,
    dbCpuMillis: 0,
    priceMonthly: 0,
    stripePriceId: null,
    stripeProductId: null,
    isPublic: true,
    features: Prisma.DbNull,
  },
  {
    name: 'pro',
    displayName: 'Pro',
    maxProjects: 20,
    maxStorageBytes: BigInt(200 * GB),
    maxTeamMembers: 10,
    maxDbSizeBytes: BigInt(16 * GB),
    maxApiRequests: 5_000_000,
    maxBandwidthBytes: BigInt(500 * GB),
    maxMau: 100_000,
    dedicatedDb: true,
    dedicatedStorage: false,
    dbMemoryMb: 1024,
    dbCpuMillis: 1000,
    priceMonthly: 2500,
    stripePriceId: null,
    stripeProductId: null,
    isPublic: true,
    features: { dailyBackups: true },
  },
  {
    name: 'business',
    displayName: 'Business',
    maxProjects: 50,
    maxStorageBytes: BigInt(1024 * GB),
    maxTeamMembers: 30,
    maxDbSizeBytes: BigInt(64 * GB),
    maxApiRequests: 20_000_000,
    maxBandwidthBytes: BigInt(2048 * GB),
    maxMau: null,
    dedicatedDb: true,
    dedicatedStorage: true,
    dbMemoryMb: 2048,
    dbCpuMillis: 2000,
    priceMonthly: 9900,
    stripePriceId: null,
    stripeProductId: null,
    isPublic: true,
    features: { dailyBackups: true, prioritySupport: true },
  },
];

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
