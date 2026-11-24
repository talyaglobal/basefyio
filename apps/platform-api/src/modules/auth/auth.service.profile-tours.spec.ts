/**
 * The profile carries the guided-tour preferences (`tours`), also when the
 * Keycloak lookups fail: the dashboard reads them from GET /auth/profile and
 * must not lose them, or anyone's session, to a Keycloak hiccup.
 */
jest.mock('minio', () => ({ Client: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('../billing/billing.service', () => ({ BillingService: class {} }));
jest.mock('../redis/redis.service', () => ({ RedisService: class {} }));
jest.mock('./keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../organizations/organizations-core.service', () => ({ OrganizationsCoreService: class {} }));

import { AuthService } from './auth.service';

const config = { get: () => undefined };

const ROW = {
  id: 'u1',
  firstName: 'A',
  lastName: 'B',
  email: 'a@example.test',
  avatarUrl: null,
  githubUsername: null,
  notifySignIn: true,
  notifySignInNewDevice: false,
  notifyTeamInvite: true,
  notifyBrowserPush: false,
  role: 'USER',
  createdAt: new Date('2026-11-24T00:00:00Z'),
  toursAutoEnabled: true,
  toursSeen: [] as string[],
};

function build(opts: { keycloakThrows?: boolean; row?: Partial<typeof ROW> } = {}) {
  const row = { ...ROW, ...opts.row };
  const prisma = {
    user: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
    },
  };
  const fail = async () => {
    throw new Error('keycloak down');
  };
  const keycloak = {
    getPlatformUserSignInMethodsById: opts.keycloakThrows
      ? jest.fn(fail)
      : jest.fn(async () => ({ authProvider: 'local', signOnMethod: 'local' })),
    getPlatformUserForcePasswordChangeById: opts.keycloakThrows ? jest.fn(fail) : jest.fn(async () => false),
  };
  const svc: AuthService = new (AuthService as any)(config, {}, keycloak, prisma, {}, {}, {}, {});
  return { svc, prisma, keycloak };
}

describe('AuthService profile — guided-tour preferences', () => {
  it('getProfile returns tours', async () => {
    const { svc } = build({ row: { toursAutoEnabled: false, toursSeen: ['shell', 'projects'] } });
    expect((await svc.getProfile('u1')).tours).toEqual({ autoEnabled: false, seen: ['shell', 'projects'] });
  });

  it('getProfile returns tours even when the Keycloak calls throw', async () => {
    const { svc, keycloak } = build({ keycloakThrows: true });
    const profile = await svc.getProfile('u1');
    expect(keycloak.getPlatformUserSignInMethodsById).toHaveBeenCalled();
    expect(profile.tours).toEqual({ autoEnabled: true, seen: [] });
    expect(profile.authProvider).toBe('local');
  });

  it('getProfile maps a null seen list to []', async () => {
    const { svc } = build({ row: { toursSeen: null as unknown as string[] } });
    expect((await svc.getProfile('u1')).tours).toEqual({ autoEnabled: true, seen: [] });
  });

  it('updateProfile returns tours too, and never writes them', async () => {
    const { svc, prisma } = build({ keycloakThrows: true, row: { toursSeen: ['shell'] } });
    const profile = await svc.updateProfile('u1', { firstName: 'Ada' });
    expect(profile.tours).toEqual({ autoEnabled: true, seen: ['shell'] });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { firstName: 'Ada' } });
  });
});
