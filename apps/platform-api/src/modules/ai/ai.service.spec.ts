import { AiService } from './ai.service';

/** The prompt must treat an open project as open, and describe the whole platform. */
describe('AiService system prompt', () => {
  const svc: any = new AiService({ get: () => undefined } as any, {} as any, {} as any);

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
