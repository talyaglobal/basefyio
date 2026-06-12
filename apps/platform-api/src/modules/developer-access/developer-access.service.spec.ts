import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { DeveloperAccessService } from './developer-access.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── Fixtures ───────────────────────────────────────────────────

const PROJECT_ID = 'proj-id';
const USER_ID    = 'user-id';

const MOCK_PROJECT = {
  id:     PROJECT_ID,
  slug:   'my-project',
  dbName: 'proj_db',
  // Intentionally NOT selecting secrets — simulates a select: {} projection.
  // The dbPassword field below represents raw DB data that must never leak.
  // (In real queries it is excluded; this fixture is used in the no-secrets test.)
};

const MOCK_PROJECT_WITH_RAW_SECRETS = {
  ...MOCK_PROJECT,
  dbPassword:    'super-secret-password',
  anonKey:       'anon-key-value',
  serviceKey:    'service-key-value',
  credentialRef: 'cred-ref-value',
};

const MOCK_MEMBER = { userId: USER_ID, projectId: PROJECT_ID };

const MOCK_ENDPOINT = {
  id:         'ep-1',
  engineType: 'relational',
  host:       'sql.proj.basefyio.com',
  port:       5432,
  username:   'proj_user',
  active:     true,
};

const MOCK_ENTITLEMENTS_ENABLED  = { externalDbAccess: true,  customDomain: false, certDownload: true };
const MOCK_ENTITLEMENTS_DISABLED = { externalDbAccess: false, customDomain: false, certDownload: false };

// ── Helpers ────────────────────────────────────────────────────

/**
 * Build a minimal PrismaService mock.
 *
 * `project`  — what project.findUnique resolves to (null = not found).
 * `member`   — what teamMember.findUnique resolves to (null = not a member).
 * `endpoints`— what projectEngineEndpoint.findMany resolves to.
 */
function buildPrisma(opts: {
  project?:   Record<string, unknown> | null;
  member?:    Record<string, unknown> | null;
  endpoints?: Record<string, unknown>[];
}) {
  return {
    project: {
      findUnique: jest.fn<any>().mockResolvedValue(opts.project ?? MOCK_PROJECT),
    },
    teamMember: {
      findUnique: jest.fn<any>().mockResolvedValue(opts.member !== undefined ? opts.member : MOCK_MEMBER),
    },
    projectEngineEndpoint: {
      findMany: jest.fn<any>().mockResolvedValue(opts.endpoints ?? [MOCK_ENDPOINT]),
    },
  };
}

/**
 * Build a minimal EntitlementService mock.
 */
function buildEntitlementMock(
  entitlements: Record<string, boolean> = MOCK_ENTITLEMENTS_ENABLED,
) {
  return {
    resolve: jest.fn<any>().mockResolvedValue(entitlements),
  };
}

/**
 * Assemble the NestJS testing module and return the service + mocks.
 */
async function buildService(opts: {
  project?:     Record<string, unknown> | null;
  member?:      Record<string, unknown> | null;
  endpoints?:   Record<string, unknown>[];
  entitlements?: Record<string, boolean>;
}) {
  const prisma       = buildPrisma(opts);
  const entitlement  = buildEntitlementMock(opts.entitlements ?? MOCK_ENTITLEMENTS_ENABLED);

  const module = await Test.createTestingModule({
    providers: [
      DeveloperAccessService,
      { provide: PrismaService,     useValue: prisma },
      { provide: EntitlementService, useValue: entitlement },
    ],
  }).compile();

  return {
    service:     module.get(DeveloperAccessService),
    prisma,
    entitlement,
  };
}

// ── DeveloperAccessService.getAccessInfo() ─────────────────────

describe('DeveloperAccessService.getAccessInfo()', () => {

  // ── Test 1: endpoint exists → returns endpoint data ──────────

  it('200 — endpoint exists → returns endpoint data', async () => {
    const { service } = await buildService({
      project:      MOCK_PROJECT,
      member:       MOCK_MEMBER,
      endpoints:    [MOCK_ENDPOINT],
      entitlements: MOCK_ENTITLEMENTS_ENABLED,
    });

    const result = await service.getAccessInfo(PROJECT_ID, USER_ID);

    expect(result.endpoints.length).toBe(1);
    expect(result.endpoints[0].host).toBe('sql.proj.basefyio.com');
    expect(result.warning).toBeUndefined();
  });

  // ── Test 2: no endpoints → returns warning ───────────────────

  it('200 — no endpoints → returns warning', async () => {
    const { service } = await buildService({
      project:      MOCK_PROJECT,
      member:       MOCK_MEMBER,
      endpoints:    [],
      entitlements: MOCK_ENTITLEMENTS_ENABLED,
    });

    const result = await service.getAccessInfo(PROJECT_ID, USER_ID);

    expect(result.endpoints.length).toBe(0);
    expect(result.warning).toContain('No engine endpoints');
  });

  // ── Test 3: externalDbAccess not entitled → empty + warning ──

  it('403 — externalDbAccess not entitled → empty endpoints + warning', async () => {
    const { service } = await buildService({
      project:      MOCK_PROJECT,
      member:       MOCK_MEMBER,
      endpoints:    [MOCK_ENDPOINT],
      entitlements: MOCK_ENTITLEMENTS_DISABLED,
    });

    const result = await service.getAccessInfo(PROJECT_ID, USER_ID);

    expect(result.endpoints.length).toBe(0);
    expect(result.warning).toContain('not enabled on your current plan');
  });

  // ── Test 4: resolve() embedded in response ───────────────────

  it('resolve() result is embedded in the response', async () => {
    const entitlements = { externalDbAccess: true, customDomain: false, certDownload: true };
    const { service } = await buildService({
      project:      MOCK_PROJECT,
      member:       MOCK_MEMBER,
      endpoints:    [MOCK_ENDPOINT],
      entitlements,
    });

    const result = await service.getAccessInfo(PROJECT_ID, USER_ID);

    expect(result.entitlements.externalDbAccess).toBe(true);
    expect(result.entitlements.customDomain).toBe(false);
  });

  // ── Test 5: no secret/key/token in response ───────────────────

  it('no secret/key/token fields leak into the response', async () => {
    // Project row has secret fields present in the raw object — they must not
    // surface in the service response even if accidentally spread.
    const { service } = await buildService({
      project:      MOCK_PROJECT_WITH_RAW_SECRETS,
      member:       MOCK_MEMBER,
      endpoints:    [MOCK_ENDPOINT],
      entitlements: MOCK_ENTITLEMENTS_ENABLED,
    });

    const result = await service.getAccessInfo(PROJECT_ID, USER_ID);
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain('password');
    expect(serialised).not.toContain('anonKey');
    expect(serialised).not.toContain('serviceKey');
    expect(serialised).not.toContain('credentialRef');
  });

  // ── Test 6: cross-tenant / non-member → ForbiddenException ───

  it('cross-tenant / 404 — non-member throws ForbiddenException', async () => {
    const { service } = await buildService({
      project:   MOCK_PROJECT,
      member:    null,           // user is not a member of this project
      endpoints: [MOCK_ENDPOINT],
    });

    await expect(
      service.getAccessInfo(PROJECT_ID, 'other-user'),
    ).rejects.toThrow(ForbiddenException);
  });

});
