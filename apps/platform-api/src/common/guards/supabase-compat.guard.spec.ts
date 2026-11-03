import { NotFoundException } from '@nestjs/common';
import { SupabaseCompatGuard, SUPABASE_COMPAT_DISABLED } from './supabase-compat.guard';

function context(req: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

function guard(rows: Record<string, boolean>) {
  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id in rows ? { supabaseCompat: rows[where.id] } : null,
      ),
    },
  };
  return { g: new SupabaseCompatGuard(prisma as any), prisma };
}

describe('SupabaseCompatGuard', () => {
  it('admits a project that has the switch on, named by its API key', async () => {
    const { g } = guard({ on: true });
    await expect(g.canActivate(context({ apiKeyPayload: { projectId: 'on' } }))).resolves.toBe(true);
  });

  it('admits a project named in the route', async () => {
    const { g } = guard({ on: true });
    await expect(g.canActivate(context({ params: { projectId: 'on' } }))).resolves.toBe(true);
  });

  it('answers 404 for every project that has not been turned on', async () => {
    const { g } = guard({ off: false });
    await expect(g.canActivate(context({ apiKeyPayload: { projectId: 'off' } }))).rejects.toThrow(
      new NotFoundException(SUPABASE_COMPAT_DISABLED),
    );
    await expect(g.canActivate(context({ apiKeyPayload: { projectId: 'unknown' } }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a request that names no project at all', async () => {
    const { g, prisma } = guard({ on: true });
    await expect(g.canActivate(context({}))).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it('prefers the route project over the key project', async () => {
    const { g, prisma } = guard({ route: true, key: false });
    await g.canActivate(context({ params: { projectId: 'route' }, apiKeyPayload: { projectId: 'key' } }));
    expect(prisma.project.findUnique).toHaveBeenCalledWith({ where: { id: 'route' }, select: { supabaseCompat: true } });
  });
});
