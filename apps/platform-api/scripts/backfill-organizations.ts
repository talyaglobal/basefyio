/* eslint-disable no-console */
/**
 * Turns the existing teams into organizations, in place and idempotently.
 *
 * Usage (from apps/platform-api):
 *   npx ts-node --transpile-only scripts/backfill-organizations.ts [--dry] [--keep-names]
 *
 * What it does, in order:
 *   1. gives every team without a public id one
 *   2. marks every personal team (personalForUserId set) as kind PERSONAL
 *   3. seeds the ADMIN/MEMBER permission rows where a team has none
 *   4. renames auto-named personal teams ("<name>'s Team") to
 *      "<name>'s Organization", keeping the <name> part exactly as the user
 *      has seen it (a profile name that changed since sign-up, or came from
 *      an OAuth login as a handle, would otherwise surprise them); a custom
 *      name is left alone (--keep-names skips this step)
 *   5. stamps organizationMigratedAt on every team that has none
 *   6. reports: users without a personal organization (the API creates
 *      those at boot through the organizations self-check, with a
 *      subscription, which this script cannot do on its own), users whose
 *      name fell back to the e-mail, and teams with projects but no OWNER
 *      (the deactivation mails go to OWNERs — such a team is flagged, never
 *      changed)
 *
 * Every step only adds or derives; nothing is deleted. Running it twice
 * changes nothing the second time. Prisma end to end, no psql.
 *
 * Env vars: DATABASE_URL — the control-plane Postgres.
 */
import { PrismaClient } from '@prisma/client';
import { newPublicId } from '../src/modules/organizations/public-id';
import { ensureDefaultRolePermissions } from '../src/modules/teams/role-permissions';
import { getDisplayName } from '../src/common/utils/display-name';

const dry = process.argv.includes('--dry');
const keepNames = process.argv.includes('--keep-names');

async function main() {
  const prisma = new PrismaClient();
  const now = new Date();
  console.log(`backfill-organizations${dry ? ' (dry run)' : ''}${keepNames ? ' --keep-names' : ''} at ${now.toISOString()}`);

  // 1. public ids
  const withoutId = await prisma.team.findMany({ where: { publicId: null }, select: { id: true } });
  console.log(`public ids missing: ${withoutId.length}`);
  if (!dry) {
    for (const t of withoutId) {
      await prisma.team.update({ where: { id: t.id }, data: { publicId: newPublicId() } });
    }
  }

  // 2. kind for personal teams
  const personalNotMarked = await prisma.team.count({ where: { personalForUserId: { not: null }, kind: { not: 'PERSONAL' } } });
  console.log(`personal teams to mark PERSONAL: ${personalNotMarked}`);
  if (!dry && personalNotMarked > 0) {
    await prisma.team.updateMany({ where: { personalForUserId: { not: null }, kind: { not: 'PERSONAL' } }, data: { kind: 'PERSONAL' } });
  }

  // 3. permission rows
  const teams = await prisma.team.findMany({ select: { id: true, _count: { select: { rolePermissions: true } } } });
  const withoutPerms = teams.filter((t) => t._count.rolePermissions < 2);
  console.log(`teams without permission rows: ${withoutPerms.length} of ${teams.length}`);
  if (!dry) {
    for (const t of withoutPerms) await ensureDefaultRolePermissions(prisma, t.id);
  }

  // 4. names
  const autoNamed = await prisma.team.findMany({
    where: { personalForUserId: { not: null }, name: { endsWith: "'s Team" } },
    select: { id: true, name: true, personalForUser: { select: { email: true, firstName: true, lastName: true } } },
  });
  console.log(`personal teams still named "…'s Team": ${autoNamed.length}`);
  let renamed = 0;
  let differsFromProfile = 0;
  if (!keepNames) {
    for (const t of autoNamed) {
      const name = t.name.replace(/'s Team$/, "'s Organization");
      const user = t.personalForUser;
      if (user && `${getDisplayName(user)}'s Organization` !== name) differsFromProfile++;
      if (dry) {
        console.log(`  would rename "${t.name}" -> "${name}"`);
      } else {
        await prisma.team.update({ where: { id: t.id }, data: { name, organizationMigratedAt: now } });
      }
      renamed++;
    }
    console.log(
      `${dry ? 'would rename' : 'renamed'}: ${renamed} (${differsFromProfile} keep a name that differs from the user's current profile name)`,
    );
  }

  // 5. migrated stamp
  const unstamped = await prisma.team.count({ where: { organizationMigratedAt: null } });
  console.log(`teams to stamp organizationMigratedAt: ${unstamped}`);
  if (!dry && unstamped > 0) {
    await prisma.team.updateMany({ where: { organizationMigratedAt: null }, data: { organizationMigratedAt: now } });
  }

  // 6. report
  const orphans = await prisma.user.findMany({ where: { personalTeam: null }, select: { id: true, email: true } });
  console.log(`users without a personal organization: ${orphans.length} (the API's boot self-check creates these)`);
  for (const u of orphans) console.log(`  ${u.id} ${u.email}`);

  const ownerless = await prisma.team.findMany({
    where: {
      members: { none: { role: 'OWNER' } },
      projects: { some: { status: { not: 'DELETED' } } },
    },
    select: { id: true, name: true, _count: { select: { projects: true } } },
  });
  console.log(`teams with projects but no OWNER (flagged, not changed): ${ownerless.length}`);
  for (const t of ownerless) console.log(`  ${t.id} "${t.name}" projects=${t._count.projects}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
