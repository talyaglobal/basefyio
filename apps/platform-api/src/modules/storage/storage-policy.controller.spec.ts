jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./storage.service', () => ({ StorageService: class {} }));
jest.mock('./storage-access.service', () => ({ StorageAccessService: class {} }));
jest.mock('../projects/project-activity.service', () => ({
  ProjectActivityService: class {},
  ProjectActivityKind: { STORAGE_BUCKET_UPDATED: 'storage.bucket_updated' },
}));
jest.mock('../../common/guards/jwt-or-apikey.guard', () => ({ JwtOrApiKeyGuard: class {} }));

import { BadRequestException } from '@nestjs/common';
import { StoragePolicyController } from './storage-policy.controller';

function deps() {
  const storage = {
    resolveProject: jest.fn().mockResolvedValue({ id: 'p1' }),
    resolveBucket: jest.fn().mockResolvedValue({ project: { id: 'p1' }, minioBucket: 'bf-p-docs' }),
    bucketIsPublic: jest.fn().mockResolvedValue(false),
  };
  const access = {
    listPolicies: jest.fn().mockResolvedValue([]),
    setPolicy: jest.fn().mockImplementation(async (_p, bucket, input) => ({
      id: 'pol', bucket, mode: input.mode, pathPrefix: input.pathPrefix ?? '',
    })),
    removePolicy: jest.fn().mockResolvedValue(1),
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  return { storage, access, activity, controller: new StoragePolicyController(storage as any, access as any, activity as any) };
}

const user = { sub: 'member-1' } as any;

describe('StoragePolicyController', () => {
  it('lists rules after the project access check', async () => {
    const { storage, access, controller } = deps();
    await controller.list('p1', user);
    expect(storage.resolveProject).toHaveBeenCalledWith('p1', 'member-1');
    expect(access.listPolicies).toHaveBeenCalledWith('p1');
  });

  it('sets a rule on a private bucket and records the activity', async () => {
    const { access, activity, controller } = deps();
    const result = await controller.set('p1', 'docs', { mode: 'owner-only', pathPrefix: 'private/' }, user);
    expect(access.setPolicy).toHaveBeenCalledWith('p1', 'docs', { mode: 'owner-only', pathPrefix: 'private/' }, 'member-1');
    expect(result).toMatchObject({ mode: 'owner-only' });
    expect(activity.append).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ kind: 'storage.bucket_updated', detail: 'owner-only (prefix "private/")' }),
    );
  });

  it('refuses a rule on a public bucket, before writing anything', async () => {
    const { storage, access, controller } = deps();
    storage.bucketIsPublic.mockResolvedValue(true);
    await expect(controller.set('p1', 'docs', { mode: 'owner-only' }, user)).rejects.toThrow(BadRequestException);
    expect(access.setPolicy).not.toHaveBeenCalled();
  });

  it('removes a rule and logs only when something was removed', async () => {
    const { access, activity, controller } = deps();
    expect(await controller.remove('p1', 'docs', 'private/', user)).toEqual({ removed: 1 });
    expect(access.removePolicy).toHaveBeenCalledWith('p1', 'docs', 'private/');
    expect(activity.append).toHaveBeenCalledTimes(1);

    access.removePolicy.mockResolvedValue(0);
    expect(await controller.remove('p1', 'docs', undefined, user)).toEqual({ removed: 0 });
    expect(access.removePolicy).toHaveBeenLastCalledWith('p1', 'docs', '');
    expect(activity.append).toHaveBeenCalledTimes(1);
  });
});
