import { BadRequestException, ConflictException } from '@nestjs/common';
import { FoldersTagsService } from './folders-tags.service';

function build(existing: { id: string } | null) {
  const prisma: any = {
    teamMember: { findFirst: jest.fn().mockResolvedValue({ id: 'm' }), findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }]) },
    projectFolder: {
      findFirst: jest.fn().mockResolvedValue(existing),
      create: jest.fn(async ({ data }: any) => ({ id: 'f1', ...data })),
    },
  };
  const realtime: any = { publish: jest.fn().mockResolvedValue(undefined) };
  return { svc: new FoldersTagsService(prisma, realtime), prisma, realtime };
}

describe('FoldersTagsService.createFolder (#147)', () => {
  it('creates a folder with a trimmed name', async () => {
    const { svc, prisma } = build(null);
    await expect(svc.createFolder('t1', 'u1', '  Kolay ')).resolves.toMatchObject({ name: 'Kolay', teamId: 't1' });
    expect(prisma.projectFolder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: 't1', name: { equals: 'Kolay', mode: 'insensitive' } } }),
    );
  });

  it('refuses a second folder with the same name in the team (409) and creates nothing', async () => {
    const { svc, prisma, realtime } = build({ id: 'f0' });
    await expect(svc.createFolder('t1', 'u1', 'Kolay')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.projectFolder.create).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
  });

  it('refuses a blank name', async () => {
    const { svc } = build(null);
    await expect(svc.createFolder('t1', 'u1', '   ')).rejects.toBeInstanceOf(BadRequestException);
  });
});
