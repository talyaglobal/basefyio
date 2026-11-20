import { ForbiddenException } from '@nestjs/common';
import { DataApiGuard, DATA_API_DISABLED } from './data-api.guard';

function context(req: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

function guard(rows: Record<string, boolean>) {
  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }: any) => (where.id in rows ? { dataApiEnabled: rows[where.id] } : null)),
    },
  };
  return new DataApiGuard(prisma as any);
}

describe('DataApiGuard', () => {
  it('admits a project with the Data API on (every existing project)', async () => {
    await expect(guard({ on: true }).canActivate(context({ apiKeyPayload: { projectId: 'on' } }))).resolves.toBe(true);
  });

  it('answers 403 for a project that turned the Data API off', async () => {
    await expect(guard({ off: false }).canActivate(context({ apiKeyPayload: { projectId: 'off' } }))).rejects.toThrow(
      new ForbiddenException(DATA_API_DISABLED),
    );
  });

  it('refuses a request no key has named a project for', async () => {
    await expect(guard({}).canActivate(context({}))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves the exposed REST schemas on the request, empty when none are set (#264)', async () => {
    const prisma = {
      project: {
        findUnique: jest.fn(async ({ where, select }: any) => {
          expect(select).toEqual({ dataApiEnabled: true, restExposedSchemas: true });
          return where.id === 'x' ? { dataApiEnabled: true, restExposedSchemas: ['r6s'] } : { dataApiEnabled: true };
        }),
      },
    };
    const g = new DataApiGuard(prisma as any);
    const withSchemas: Record<string, unknown> = { apiKeyPayload: { projectId: 'x' } };
    await g.canActivate(context(withSchemas));
    expect(withSchemas.restExposedSchemas).toEqual(['r6s']);
    const plain: Record<string, unknown> = { apiKeyPayload: { projectId: 'y' } };
    await g.canActivate(context(plain));
    expect(plain.restExposedSchemas).toEqual([]);
  });
});
