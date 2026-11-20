import { AiService } from './ai.service';

/** The prompt must treat an open project as open, and describe the whole platform. */
describe('AiService system prompt', () => {
  const svc: any = new AiService({ get: () => undefined } as any, {} as any, {} as any, {} as any);

  it('never asks to open a project that is already open', () => {
    const p = svc.buildSystemPrompt({ projectId: 'p1', projectName: 'QA', tables: [] });
    expect(p).toContain('already open');
    expect(p).not.toContain('after opening the project');
  });

  it('lists the known tables when there are some', () => {
    const p = svc.buildSystemPrompt({ projectId: 'p1', projectName: 'QA', tables: ['users', 'orders'] });
    expect(p).toContain('Known tables: users, orders');
    expect(p).not.toContain('came back empty');
  });

  it('describes more than PostgreSQL', () => {
    const p = svc.buildSystemPrompt({});
    for (const w of ['NoSQL', 'Storage', 'Auth', 'Realtime', 'Flows']) expect(p).toContain(w);
  });
});

describe('AiService.chat — plan gate', () => {
  function make(allowed: boolean) {
    const entitlements = {
      assertTeamCanUseAi: jest.fn(async () => {
        if (!allowed) throw new (require('@nestjs/common').ForbiddenException)('Pro plan and above');
      }),
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ activeTeamId: 'team-active' }) },
      project: {
        findFirst: jest.fn().mockResolvedValue({ teamId: 'team-of-open-project' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const svc: any = new AiService({ get: (k: string) => (k === 'openai.apiKey' ? 'sk-test' : undefined) } as any, prisma as any, {} as any, entitlements as any);
    return { svc, prisma, entitlements };
  }

  it('refuses before any model call when the plan does not include AI', async () => {
    const { svc, entitlements } = make(false);
    await expect(svc.chat('u1', 'how do I create a table in my project', [], {})).rejects.toThrow(/Pro plan/);
    expect(entitlements.assertTeamCanUseAi).toHaveBeenCalledWith('team-active');
  });

  it('judges the plan of the open project team, not only the active team', async () => {
    const { svc, entitlements } = make(false);
    await expect(svc.chat('u1', 'sql for my project', [], { projectId: 'p1' })).rejects.toThrow();
    expect(entitlements.assertTeamCanUseAi).toHaveBeenCalledWith('team-of-open-project');
  });
});
