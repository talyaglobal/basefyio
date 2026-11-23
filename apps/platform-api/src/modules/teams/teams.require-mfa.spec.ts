jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { BadRequestException } from '@nestjs/common';
import { TeamsService } from './teams.service';

/** Owner decision 2026-11-23: two-factor authentication is optional; an organization cannot require it. */
describe('TeamsService.setRequireMfa', () => {
  function build(requireMfa = false) {
    const prisma = {
      team: {
        findUnique: jest.fn(async () => ({ requireMfa })),
        update: jest.fn(async () => ({ id: 't1', requireMfa: false, requireMfaUpdatedAt: new Date() })),
      },
      teamMember: { findMany: jest.fn(async () => [{ userId: 'u2' }]) },
    };
    const mfa = { requiredElsewhere: jest.fn(async () => false), releasePendingSetup: jest.fn(async () => undefined) };
    const svc = Object.create(TeamsService.prototype) as any;
    Object.assign(svc, {
      prisma,
      mfa,
      logger: { log: jest.fn() },
      realtime: { publish: jest.fn(async () => undefined) },
      assertOwner: jest.fn(async () => undefined),
    });
    return { svc: svc as TeamsService, prisma, mfa };
  }

  it('refuses to turn the requirement on, and changes nothing', async () => {
    const { svc, prisma } = build();
    await expect(svc.setRequireMfa('t1', 'u1', true)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.team.update).not.toHaveBeenCalled();
  });

  it('still turns an old requirement off and releases pending setups', async () => {
    const { svc, prisma, mfa } = build(true);
    await svc.setRequireMfa('t1', 'u1', false);
    expect(prisma.team.update).toHaveBeenCalled();
    expect(mfa.releasePendingSetup).toHaveBeenCalledWith('u2');
  });
});
