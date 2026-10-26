import { BadRequestException } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';

function makePrisma(rows: Array<{ key: string; value: unknown }>) {
  return {
    systemSetting: {
      findMany: jest.fn().mockResolvedValue(rows),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
}

const OFF = { organizations_ui: false, nav_v2: false };

describe('FeatureFlagsService', () => {
  it('defaults every flag to off and reads the stored value when there is one', async () => {
    const service = new FeatureFlagsService(makePrisma([]) as any);
    expect(await service.all()).toEqual(OFF);

    const on = new FeatureFlagsService(makePrisma([{ key: 'features.organizations_ui', value: true }]) as any);
    expect(await on.isEnabled('organizations_ui')).toBe(true);
  });

  it('ignores rows for flags it does not know and non-boolean values', async () => {
    const prisma = makePrisma([
      { key: 'features.something_else', value: true },
      { key: 'features.organizations_ui', value: 'yes' },
      { key: 'features.nav_v2.users', value: 'u1' },
    ]);
    const service = new FeatureFlagsService(prisma as any);
    expect(await service.all()).toEqual(OFF);
    expect((await service.management()).users).toEqual({ organizations_ui: [], nav_v2: [] });
  });

  it('reads the table once per 30 seconds', async () => {
    const prisma = makePrisma([]);
    const service = new FeatureFlagsService(prisma as any);
    await service.all();
    await service.all();
    await service.isEnabled('organizations_ui');
    await service.forUser('u1');
    expect(prisma.systemSetting.findMany).toHaveBeenCalledTimes(1);
  });

  it('writes a flip, drops the cache and refuses an unknown flag', async () => {
    const prisma = makePrisma([]);
    const service = new FeatureFlagsService(prisma as any);
    await service.all();
    prisma.systemSetting.findMany.mockResolvedValue([{ key: 'features.organizations_ui', value: true }]);

    const after = await service.set('organizations_ui', true);

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'features.organizations_ui' },
      create: { key: 'features.organizations_ui', value: true },
      update: { value: true },
    });
    expect(after.organizations_ui).toBe(true);
    await expect(service.set('nope', true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('turns a flag on for the listed users before everyone, and for everyone once flipped', async () => {
    const prisma = makePrisma([{ key: 'features.nav_v2.users', value: ['owner', 'tester', 42] }]);
    const service = new FeatureFlagsService(prisma as any);
    expect(await service.all()).toEqual(OFF);
    expect(await service.forUser('owner')).toEqual({ ...OFF, nav_v2: true });
    expect(await service.forUser('someone')).toEqual(OFF);
    expect(await service.isEnabled('nav_v2', 'tester')).toBe(true);
    expect((await service.management()).users.nav_v2).toEqual(['owner', 'tester']);

    prisma.systemSetting.findMany.mockResolvedValue([
      { key: 'features.nav_v2', value: true },
      { key: 'features.nav_v2.users', value: ['owner'] },
    ]);
    await service.set('nav_v2', true);
    expect(await service.forUser('someone')).toEqual({ ...OFF, nav_v2: true });
  });

  it('replaces the user list, de-duplicated and trimmed, and refuses an unknown flag', async () => {
    const prisma = makePrisma([]);
    const service = new FeatureFlagsService(prisma as any);
    prisma.systemSetting.findMany.mockResolvedValue([{ key: 'features.nav_v2.users', value: ['a', 'b'] }]);
    const users = await service.setUsers('nav_v2', [' a ', 'b', 'a', '']);
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'features.nav_v2.users' },
      create: { key: 'features.nav_v2.users', value: ['a', 'b'] },
      update: { value: ['a', 'b'] },
    });
    expect(users.nav_v2).toEqual(['a', 'b']);
    await expect(service.setUsers('nope', ['a'])).rejects.toBeInstanceOf(BadRequestException);
  });
});
