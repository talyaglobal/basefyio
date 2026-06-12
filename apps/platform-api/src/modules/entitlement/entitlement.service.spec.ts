import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { EntitlementKey } from './entitlement-key';
import { PrismaService } from '../../prisma/prisma.service';

// ── Fixtures ───────────────────────────────────────────────────

const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';
const TEAM_A    = 'team-a';
const TEAM_B    = 'team-b';

const KEY = EntitlementKey.MIGRATION_ARCHIVE_CREATE;

/** Build a subscription-like object as Prisma would return it. */
function makeActiveSub(features: Record<string, boolean> | null = { [KEY]: true }) {
  return {
    status: 'ACTIVE',
    plan: { features },
  };
}

/**
 * Minimal Prisma mock.
 *
 * `projectRows` maps projectId → { teamId }  (null = project not found).
 * `subRows`     maps teamId   → sub record    (null = no subscription).
 */
function buildPrisma(
  projectRows: Record<string, { teamId: string } | null> = {},
  subRows: Record<string, ReturnType<typeof makeActiveSub> | null> = {},
) {
  return {
    project: {
      findUnique: jest.fn<any>().mockImplementation(({ where }: { where: { id: string } }) => {
        const row = projectRows[where.id];
        return Promise.resolve(row !== undefined ? row : null);
      }),
    },
    subscription: {
      findUnique: jest.fn<any>().mockImplementation(({ where }: { where: { teamId: string } }) => {
        const row = subRows[where.teamId];
        return Promise.resolve(row !== undefined ? row : null);
      }),
    },
  };
}

async function buildService(
  projectRows: Record<string, { teamId: string } | null> = {},
  subRows: Record<string, ReturnType<typeof makeActiveSub> | null> = {},
) {
  const prisma = buildPrisma(projectRows, subRows);
  const module = await Test.createTestingModule({
    providers: [
      EntitlementService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { svc: module.get(EntitlementService), prisma };
}

// ── EntitlementService.can() ───────────────────────────────────

describe('EntitlementService.can()', () => {
  it('returns true when subscription is ACTIVE and plan.features[key] === true', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub({ [KEY]: true }) },
    );
    await expect(svc.can(PROJECT_A, KEY)).resolves.toBe(true);
  });

  it('returns false when project does not exist', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: null },
      { [TEAM_A]: makeActiveSub() },
    );
    await expect(svc.can(PROJECT_A, KEY)).resolves.toBe(false);
  });

  it('returns false when subscription does not exist for the team', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: null },
    );
    await expect(svc.can(PROJECT_A, KEY)).resolves.toBe(false);
  });

  it('returns false when subscription status is PAST_DUE', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: { status: 'PAST_DUE', plan: { features: { [KEY]: true } } } },
    );
    await expect(svc.can(PROJECT_A, KEY)).resolves.toBe(false);
  });

  it('returns false when plan.features[key] is false', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub({ [KEY]: false }) },
    );
    await expect(svc.can(PROJECT_A, KEY)).resolves.toBe(false);
  });

  it('returns false when plan.features[key] is absent from the features object', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub({}) },                  // key not present at all
    );
    await expect(svc.can(PROJECT_A, KEY)).resolves.toBe(false);
  });

  it('returns false when plan.features is null', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub(null) },
    );
    await expect(svc.can(PROJECT_A, KEY)).resolves.toBe(false);
  });
});

// ── EntitlementService.assertCan() ────────────────────────────

describe('EntitlementService.assertCan()', () => {
  it('resolves without throwing when the feature is allowed', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub({ [KEY]: true }) },
    );
    await expect(svc.assertCan(PROJECT_A, KEY)).resolves.toBeUndefined();
  });

  it('throws ForbiddenException when plan.features[key] is false', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub({ [KEY]: false }) },
    );
    await expect(svc.assertCan(PROJECT_A, KEY)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when there is no active subscription', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: null },
    );
    await expect(svc.assertCan(PROJECT_A, KEY)).rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException when the project does not exist', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: null },
      {},
    );
    await expect(svc.assertCan(PROJECT_A, KEY)).rejects.toThrow(NotFoundException);
  });

  it('error message contains the key name when the feature is missing from the plan', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub({}) },
    );
    await expect(svc.assertCan(PROJECT_A, KEY)).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining(KEY) }),
    );
  });
});

// ── Tenant isolation ───────────────────────────────────────────

describe('EntitlementService — tenant isolation', () => {
  it('subscription lookup uses the teamId from the project, not a hardcoded value', async () => {
    const { svc, prisma } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub({ [KEY]: true }) },
    );
    await svc.can(PROJECT_A, KEY);
    expect((prisma as any).subscription.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: TEAM_A } }),
    );
    // Must NOT have been called with any other teamId
    const calls: any[] = ((prisma as any).subscription.findUnique as jest.MockedFunction<any>).mock.calls;
    expect(calls.every((c: any[]) => c[0].where.teamId === TEAM_A)).toBe(true);
  });

  it('project A with no sub returns false even when project B (different team) has the feature', async () => {
    // team-b has an ACTIVE sub with the feature enabled; team-a has no sub at all.
    const { svc } = await buildService(
      {
        [PROJECT_A]: { teamId: TEAM_A },
        [PROJECT_B]: { teamId: TEAM_B },
      },
      {
        [TEAM_A]: null,
        [TEAM_B]: makeActiveSub({ [KEY]: true }),
      },
    );
    // Project B is allowed
    await expect(svc.can(PROJECT_B, KEY)).resolves.toBe(true);
    // Project A must not be allowed, even though team-b's sub is in the mock
    await expect(svc.can(PROJECT_A, KEY)).resolves.toBe(false);
  });
});

// ── EntitlementService.resolve() ──────────────────────────────

describe('EntitlementService.resolve()', () => {
  it('returns an object with all known EntitlementKey values populated (true/false)', async () => {
    const allTrue = Object.fromEntries(
      Object.values(EntitlementKey).map((k) => [k, true]),
    );
    const { svc } = await buildService(
      { [PROJECT_A]: { teamId: TEAM_A } },
      { [TEAM_A]: makeActiveSub(allTrue) },
    );
    const result = await svc.resolve(PROJECT_A);
    for (const key of Object.values(EntitlementKey)) {
      expect(result).toHaveProperty(key);
      expect(typeof result[key]).toBe('boolean');
    }
  });

  it('returns an empty object when the project is not found', async () => {
    const { svc } = await buildService(
      { [PROJECT_A]: null },
      {},
    );
    const result = await svc.resolve(PROJECT_A);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
