import { ItemPolicyGuard } from './item-policy.guard';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

function makeContext(appRole?: string, params = { projectId: 'p-1', entityName: 'customers' }) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: appRole ? { app_role: appRole } : {}, params }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as any;
}

function makePrisma(roleName = 'viewer', perms = ['read']) {
  return {
    blueprint: { findFirst: jest.fn().mockResolvedValue({ currentVersionId: 'ver-1' }) },
    applicationVersion: {
      findUnique: jest.fn().mockResolvedValue({
        applicationModel: { roles: [{ name: roleName, permissions: { customers: perms } }] },
      }),
    },
  };
}

describe('ItemPolicyGuard', () => {
  it('allows when no app_role claim', async () => {
    const reflector = { get: jest.fn().mockReturnValue('read') } as any;
    const guard = new ItemPolicyGuard(reflector, {} as any);
    await expect(guard.canActivate(makeContext(undefined))).resolves.toBe(true);
  });

  it('allows when no required permission annotation', async () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as any;
    const guard = new ItemPolicyGuard(reflector, {} as any);
    await expect(guard.canActivate(makeContext('viewer'))).resolves.toBe(true);
  });

  it('allows viewer to read customers', async () => {
    const reflector = { get: jest.fn().mockReturnValue('read') } as any;
    const guard = new ItemPolicyGuard(reflector, makePrisma('viewer', ['read']) as any);
    await expect(guard.canActivate(makeContext('viewer'))).resolves.toBe(true);
  });

  it('blocks viewer from writing customers', async () => {
    const reflector = { get: jest.fn().mockReturnValue('write') } as any;
    const guard = new ItemPolicyGuard(reflector, makePrisma('viewer', ['read']) as any);
    await expect(guard.canActivate(makeContext('viewer'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows admin with write permission', async () => {
    const reflector = { get: jest.fn().mockReturnValue('write') } as any;
    const guard = new ItemPolicyGuard(reflector, makePrisma('admin', ['read', 'write', 'delete']) as any);
    await expect(guard.canActivate(makeContext('admin'))).resolves.toBe(true);
  });

  it('throws ForbiddenException when role not found', async () => {
    const reflector = { get: jest.fn().mockReturnValue('read') } as any;
    const guard = new ItemPolicyGuard(reflector, makePrisma('admin', ['read']) as any);
    await expect(guard.canActivate(makeContext('unknown-role'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
