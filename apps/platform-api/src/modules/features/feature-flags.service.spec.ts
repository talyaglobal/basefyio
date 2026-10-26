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

describe('FeatureFlagsService', () => {
  it('defaults every flag to off and reads the stored value when there is one', async () => {
    const service = new FeatureFlagsService(makePrisma([]) as any);
    expect(await service.all()).toEqual({ organizations_ui: false });

    const on = new FeatureFlagsService(makePrisma([{ key: 'features.organizations_ui', value: true }]) as any);
    expect(await on.isEnabled('organizations_ui')).toBe(true);
  });

  it('ignores rows for flags it does not know and non-boolean values', async () => {
    const prisma = makePrisma([
      { key: 'features.something_else', value: true },
      { key: 'features.organizations_ui', value: 'yes' },
    ]);
    const service = new FeatureFlagsService(prisma as any);
    expect(await service.all()).toEqual({ organizations_ui: false });
  });

  it('reads the table once per 30 seconds', async () => {
    const prisma = makePrisma([]);
    const service = new FeatureFlagsService(prisma as any);
    await service.all();
    await service.all();
    await service.isEnabled('organizations_ui');
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
});
