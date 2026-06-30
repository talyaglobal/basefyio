import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModuleEnabledGuard } from './module-enabled.guard';
import { MODULE_KEY } from '../decorators/require-module.decorator';

// ── Mock factories ───────────────────────────────────────────

function makeReflector(module: string | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(module),
  } as any;
}

function makePrisma(modules: Record<string, unknown> | null) {
  return {
    project: {
      findUnique: jest.fn().mockResolvedValue(
        modules === null ? null : { modules },
      ),
    },
  } as any;
}

function makeContext(overrides: {
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
} = {}): ExecutionContext {
  const req = {
    params: overrides.params ?? {},
    body: overrides.body ?? {},
    query: overrides.query ?? {},
  };
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────

describe('ModuleEnabledGuard', () => {
  it('passes when no module key is set on the handler', async () => {
    const guard = new ModuleEnabledGuard(makeReflector(undefined), makePrisma({}));
    const result = await guard.canActivate(makeContext({ body: { projectId: 'p-1' } }));
    expect(result).toBe(true);
  });

  it('passes when module flag is absent (default enabled — backward compatible)', async () => {
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), makePrisma({}));
    const result = await guard.canActivate(makeContext({ body: { projectId: 'p-1' } }));
    expect(result).toBe(true);
  });

  it('passes when module flag is explicitly true', async () => {
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), makePrisma({ provisioning: true }));
    const result = await guard.canActivate(makeContext({ body: { projectId: 'p-1' } }));
    expect(result).toBe(true);
  });

  it('throws ForbiddenException when module flag is false', async () => {
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), makePrisma({ provisioning: false }));
    await expect(
      guard.canActivate(makeContext({ body: { projectId: 'p-1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ForbiddenException message names the blocked module', async () => {
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), makePrisma({ provisioning: false }));
    await expect(
      guard.canActivate(makeContext({ body: { projectId: 'p-1' } })),
    ).rejects.toThrow(/provisioning/);
  });

  it('passes when no projectId is resolvable (let service handle 404 / ownership)', async () => {
    const prisma = makePrisma({});
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), prisma);
    const result = await guard.canActivate(makeContext());
    expect(result).toBe(true);
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it('resolves projectId from req.params', async () => {
    const prisma = makePrisma({});
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), prisma);
    await guard.canActivate(makeContext({ params: { projectId: 'p-params' } }));
    expect(prisma.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-params' } }),
    );
  });

  it('resolves projectId from req.query', async () => {
    const prisma = makePrisma({});
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), prisma);
    await guard.canActivate(makeContext({ query: { projectId: 'p-query' } }));
    expect(prisma.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-query' } }),
    );
  });

  it('resolves projectId from req.body', async () => {
    const prisma = makePrisma({});
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), prisma);
    await guard.canActivate(makeContext({ body: { projectId: 'p-body' } }));
    expect(prisma.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-body' } }),
    );
  });

  it('passes when project is not found (let service throw NotFoundException)', async () => {
    const guard = new ModuleEnabledGuard(makeReflector('provisioning'), makePrisma(null));
    const result = await guard.canActivate(makeContext({ body: { projectId: 'missing' } }));
    expect(result).toBe(true);
  });

  it('does not block other modules when only provisioning is disabled', async () => {
    const guard = new ModuleEnabledGuard(makeReflector('analytics'), makePrisma({ provisioning: false }));
    const result = await guard.canActivate(makeContext({ body: { projectId: 'p-1' } }));
    expect(result).toBe(true);
  });

  it('guards use MODULE_KEY constant as the metadata key', () => {
    const reflector = makeReflector('provisioning');
    new ModuleEnabledGuard(reflector, makePrisma({}));
    // Trigger canActivate to verify reflector is called with the right key
    const ctx = makeContext({ body: { projectId: 'p-1' } });
    void new ModuleEnabledGuard(reflector, makePrisma({})).canActivate(ctx);
    expect((reflector.getAllAndOverride as jest.Mock).mock.calls[0][0]).toBe(MODULE_KEY);
  });
});
