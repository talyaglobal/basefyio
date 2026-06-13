import { describe, it, expect, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { DeveloperAccessController } from './developer-access.controller';
import { DeveloperAccessService } from './developer-access.service';
import { CertificateService } from '../certificates/certificate.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';

// ── Fixtures ───────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

const MOCK_ACCESS_INFO_FULL = {
  endpoints: [
    {
      id: 'ep-1',
      host: 'db.example.com',
      port: 5432,
      database: 'proj_1_db',
    },
  ],
  entitlements: {
    externalAccess: true,
    maxConnections: 10,
  },
  warning: null,
};

const MOCK_ACCESS_INFO_NO_ENDPOINT = {
  endpoints: [],
  entitlements: {
    externalAccess: true,
    maxConnections: 10,
  },
  warning: 'No engine endpoints are currently provisioned for this project.',
};

const MOCK_ACCESS_INFO_NOT_ENTITLED = {
  endpoints: [],
  entitlements: {
    externalAccess: false,
    maxConnections: 0,
  },
  warning: 'External database access is not enabled on your current plan.',
};

// ── Helpers ────────────────────────────────────────────────────

async function buildController(serviceOverrides: Record<string, any> = {}) {
  const mockService = {
    getAccessInfo: jest.fn<any>().mockResolvedValue(MOCK_ACCESS_INFO_FULL),
    ...serviceOverrides,
  };

  const mockCertificates = {
    list: jest.fn<any>().mockResolvedValue([]),
    issue: jest.fn<any>().mockResolvedValue({}),
    renew: jest.fn<any>().mockResolvedValue({}),
    revoke: jest.fn<any>().mockResolvedValue(undefined),
    getBundle: jest.fn<any>().mockResolvedValue({}),
  };

  const module: TestingModule = await Test.createTestingModule({
    controllers: [DeveloperAccessController],
    providers: [
      { provide: DeveloperAccessService, useValue: mockService },
      { provide: CertificateService, useValue: mockCertificates },
    ],
  })
    .overrideGuard(JwtOrApiKeyGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return {
    ctrl: module.get(DeveloperAccessController),
    svc: mockService,
  };
}

// ── GET /v1/projects/:projectId/access ────────────────────────

describe('DeveloperAccessController GET /v1/projects/:projectId/access', () => {
  it('200 with endpoint — returns full AccessInfoView when an endpoint exists', async () => {
    const { ctrl, svc } = await buildController();

    const result = await ctrl.getAccessInfo(PROJECT_ID, { sub: USER_ID } as any);

    expect(svc.getAccessInfo).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
    expect(result).toEqual(MOCK_ACCESS_INFO_FULL);
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].host).toBe('db.example.com');
  });

  it('200 with warning (no endpoint) — returns empty endpoints array with provisioning warning', async () => {
    const { ctrl } = await buildController({
      getAccessInfo: jest.fn<any>().mockResolvedValue(MOCK_ACCESS_INFO_NO_ENDPOINT),
    });

    const result = await ctrl.getAccessInfo(PROJECT_ID, { sub: USER_ID } as any);

    expect(result).toEqual(MOCK_ACCESS_INFO_NO_ENDPOINT);
    expect(result.endpoints).toHaveLength(0);
    expect(result.warning).toMatch(/No engine endpoints/);
  });

  it('200 with warning (not entitled) — returns empty endpoints array with entitlement warning', async () => {
    const { ctrl } = await buildController({
      getAccessInfo: jest.fn<any>().mockResolvedValue(MOCK_ACCESS_INFO_NOT_ENTITLED),
    });

    const result = await ctrl.getAccessInfo(PROJECT_ID, { sub: USER_ID } as any);

    expect(result).toEqual(MOCK_ACCESS_INFO_NOT_ENTITLED);
    expect(result.endpoints).toHaveLength(0);
    expect(result.warning).toMatch(/External database access is not enabled/);
  });

  it('403 cross-tenant — propagates ForbiddenException thrown by service', async () => {
    const { ctrl } = await buildController({
      getAccessInfo: jest.fn<any>().mockRejectedValue(new ForbiddenException()),
    });

    await expect(
      ctrl.getAccessInfo(PROJECT_ID, { sub: USER_ID } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('resolve() embedded — response contains an entitlements object', async () => {
    const { ctrl } = await buildController();

    const result = await ctrl.getAccessInfo(PROJECT_ID, { sub: USER_ID } as any);

    expect(result.entitlements).toBeDefined();
    expect(typeof result.entitlements).toBe('object');
  });

  it('no secrets — response does not expose password, token, secret, or apiKey fields', async () => {
    const { ctrl } = await buildController();

    const result = await ctrl.getAccessInfo(PROJECT_ID, { sub: USER_ID } as any);

    const json = JSON.stringify(result);
    const parsed: Record<string, unknown> = JSON.parse(json);

    const forbidden = new Set(['password', 'token', 'secret', 'apiKey']);
    const walk = (obj: unknown): void => {
      if (obj === null || typeof obj !== 'object') return;
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        expect(forbidden.has(key)).toBe(false);
        walk((obj as Record<string, unknown>)[key]);
      }
    };
    walk(parsed);
  });
});
