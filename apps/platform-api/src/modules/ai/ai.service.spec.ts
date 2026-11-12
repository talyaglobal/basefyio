import { AiService, AiStreamEvent, _sanitizeHistoryForTest } from './ai.service';
import type { LlmClient, LlmRequest } from './ai-llm';

/** A scripted model: each stream()/complete() call takes the next reply. */
function scriptedLlm(streams: string[], completes: string[] = []): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    provider: 'openai',
    model: 'test-model',
    calls,
    async *stream(req: LlmRequest) {
      calls.push(req);
      const text = streams.shift() ?? '';
      for (const piece of text.match(/[\s\S]{1,20}/g) ?? []) yield piece;
    },
    async complete(req: LlmRequest) {
      calls.push(req);
      return completes.shift() ?? 'IN';
    },
  };
}

const projectRow = { id: 'p1', name: 'Blog', teamId: 't1', dbHost: 'h', dbPort: 5432, dbUser: 'u', dbPassword: 'x', dbName: 'd' };
const schema = {
  tables: [
    {
      schema: 'public',
      name: 'qa_e2e_ai_posts',
      columns: [{ name: 'id', type: 'bigint', nullable: false, default: null }],
      primaryKey: ['id'],
      foreignKeys: [],
      rlsEnabled: false,
      policies: [],
      estimatedRows: 0,
    },
  ],
  authFunctions: [{ name: 'auth.uid', returns: 'text' }],
  truncated: false,
  postgresVersion: '16.4',
};

function setup(llm: LlmClient) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ activeTeamId: 't1' }) },
    project: { findMany: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Blog' }]) },
  };
  const rag = { retrieveContext: jest.fn().mockResolvedValue('') };
  const db = {
    resolveProject: jest.fn().mockResolvedValue(projectRow),
    readSchema: jest.fn().mockResolvedValue(schema),
    runReadOnly: jest.fn().mockResolvedValue([
      { sql: 'SELECT count(*) FROM qa_e2e_ai_posts', ok: true, command: 'SELECT', rowCount: 1, fields: ['count'], rows: [{ count: 0 }], truncated: false, durationMs: 2 },
    ]),
    dryRun: jest.fn().mockResolvedValue({ status: 'passed', failedIndex: null, error: null, notes: [] }),
    apply: jest.fn(),
  };
  const proposals = {
    create: jest.fn().mockImplementation(async (userId, projectId, statements, validation) => ({
      id: '00000000-0000-0000-0000-000000000001',
      userId,
      projectId,
      statements,
      validation,
      createdAt: 'now',
      expiresAt: 'later',
    })),
    take: jest.fn(),
    restore: jest.fn(),
  };
  const settings = { resolve: jest.fn().mockResolvedValue({ client: llm, source: 'platform' }) };
  const service = new AiService(prisma as any, rag as any, db as any, proposals as any, settings as any);
  return { service, prisma, db, proposals, settings };
}

async function run(service: AiService, body: any): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  await service.stream('u1', body, (e) => events.push(e), undefined);
  return events;
}

describe('AiService.stream', () => {
  it('answers a Turkish question without a refusal and sends the live schema', async () => {
    const llm = scriptedLlm(['Projede 1 tablo var: qa_e2e_ai_posts.']);
    const { service } = setup(llm);
    const events = await run(service, {
      message: 'Bu projede hangi tablolar var?',
      context: { projectId: 'p1', mode: 'ask' },
    });
    const text = events.filter((e) => e.event === 'delta').map((e: any) => e.data.text).join('');
    expect(text).toBe('Projede 1 tablo var: qa_e2e_ai_posts.');
    // No scope judge call: the quick check recognised the question.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toContain('qa_e2e_ai_posts(id bigint not null)');
    expect(llm.calls[0].system).toContain('auth.uid() returns text');
    expect(events.find((e) => e.event === 'meta')).toMatchObject({ data: { tables: 1 } });
  });

  it('lets the scope judge refuse an off-topic message in its own words', async () => {
    const llm = scriptedLlm([], ['Üzgünüm, yalnızca basefyio konularında yardımcı olabilirim.']);
    const { service } = setup(llm);
    const events = await run(service, { message: 'Bana bir şiir yaz', context: {} });
    expect(events.find((e) => e.event === 'delta')).toMatchObject({
      data: { text: 'Üzgünüm, yalnızca basefyio konularında yardımcı olabilirim.' },
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toMatch(/You decide whether a message is for the basefyio assistant/);
  });

  it('in Agent mode runs reads, turns changes into proposals and never applies them', async () => {
    const reply = [
      'First I count the posts:',
      '```sql\nSELECT count(*) FROM qa_e2e_ai_posts;\n```',
      'Then enable RLS:',
      '```sql\nALTER TABLE qa_e2e_ai_posts ENABLE ROW LEVEL SECURITY;\nCREATE POLICY read_all ON qa_e2e_ai_posts FOR SELECT USING (true);\n```',
    ].join('\n');
    const llm = scriptedLlm([reply, 'There are 0 posts. The RLS change is waiting for your approval.']);
    const { service, db, proposals } = setup(llm);

    const events = await run(service, { message: 'RLS: herkes okusun', context: { projectId: 'p1', mode: 'agent' } });

    expect(db.runReadOnly).toHaveBeenCalledWith(projectRow, 'u1', ['SELECT count(*) FROM qa_e2e_ai_posts']);
    expect(db.dryRun).toHaveBeenCalledTimes(1);
    expect(db.apply).not.toHaveBeenCalled();
    expect(proposals.create).toHaveBeenCalledTimes(1);
    const proposal = events.find((e) => e.event === 'proposal') as any;
    expect(proposal.data.proposal.id).toBe('00000000-0000-0000-0000-000000000001');
    expect(proposal.data.statements.map((s: any) => s.command)).toEqual(['ALTER TABLE', 'CREATE POLICY']);
    // The follow-up is grounded in the real results and told about the pending change.
    const followupPrompt = llm.calls[1].turns[llm.calls[1].turns.length - 1].content;
    expect(followupPrompt).toContain('[{"count":0}]');
    expect(followupPrompt).toContain('NOT been applied');
    const done = events.find((e) => e.event === 'done') as any;
    expect(done.data.followup).toContain('waiting for your approval');
  });

  it('asks the model to correct SQL that failed the dry run, and stores only the corrected version', async () => {
    const reply = '```sql\nCREATE POLICY p ON qa_e2e_ai_posts FOR INSERT USING (owner_id = current_user_id);\n```';
    const fixed = '```sql\nCREATE POLICY p ON qa_e2e_ai_posts FOR INSERT WITH CHECK (owner_id = auth.uid());\n```';
    const llm = scriptedLlm([reply], [fixed]);
    const { service, db, proposals } = setup(llm);
    db.dryRun
      .mockResolvedValueOnce({ status: 'failed', failedIndex: 0, error: 'only WITH CHECK expression allowed for INSERT', notes: [] })
      .mockResolvedValueOnce({ status: 'passed', failedIndex: null, error: null, notes: [] });

    const events = await run(service, { message: 'add an insert policy', context: { projectId: 'p1', mode: 'agent' } });

    const proposal = events.find((e) => e.event === 'proposal') as any;
    expect(proposal.data.correctedFrom).toContain('current_user_id');
    expect(proposal.data.sql).toContain('auth.uid()');
    expect(proposals.create.mock.calls[0][2][0].sql).toContain('WITH CHECK (owner_id = auth.uid())');
  });

  it('shows SQL that still fails validation without storing it for approval', async () => {
    const llm = scriptedLlm(['```sql\nALTER TABLE nope ADD COLUMN x int;\n```'], ['```sql\nALTER TABLE nope2 ADD COLUMN x int;\n```']);
    const { service, db, proposals } = setup(llm);
    db.dryRun.mockResolvedValue({ status: 'failed', failedIndex: 0, error: 'relation "nope2" does not exist', notes: [] });

    const events = await run(service, { message: 'add a column to table nope', context: { projectId: 'p1', mode: 'agent' } });

    const proposal = events.find((e) => e.event === 'proposal') as any;
    expect(proposal.data.proposal).toBeNull();
    expect(proposal.data.validation).toMatchObject({ status: 'failed' });
    expect(proposal.data.validation.error).toContain('does not exist');
    expect(proposals.create).not.toHaveBeenCalled();
  });

  it('does not execute anything in Plan mode', async () => {
    const llm = scriptedLlm(['1. Create the table\n```sql\nCREATE TABLE posts (id bigint);\n```']);
    const { service, db } = setup(llm);
    await run(service, { message: 'plan a posts table', context: { projectId: 'p1', mode: 'plan' } });
    expect(db.runReadOnly).not.toHaveBeenCalled();
    expect(db.dryRun).not.toHaveBeenCalled();
  });

  it('reports a missing model configuration as an error event', async () => {
    const { service, settings } = setup(scriptedLlm([]));
    settings.resolve.mockResolvedValue(null);
    const events = await run(service, { message: 'what tables?', context: {} });
    expect(events.find((e) => e.event === 'error')).toMatchObject({ data: { code: 'AI_NOT_CONFIGURED' } });
  });

  it('ignores a project that is not in the caller team', async () => {
    const llm = scriptedLlm(['ok']);
    const { service, db } = setup(llm);
    await run(service, { message: 'which tables exist?', context: { projectId: 'someone-elses', mode: 'agent' } });
    expect(db.readSchema).not.toHaveBeenCalled();
  });
});

describe('AiService.approve', () => {
  it('runs the stored SQL and returns a summary built from the database', async () => {
    const { service, proposals, db } = setup(scriptedLlm([]));
    proposals.take.mockResolvedValue({
      id: 'x',
      userId: 'u1',
      projectId: 'p1',
      statements: [{ sql: 'ALTER TABLE posts ENABLE ROW LEVEL SECURITY', kind: 'schema', command: 'ALTER TABLE', destructive: false, warning: null }],
      validation: null,
      createdAt: '',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    db.apply.mockResolvedValue({
      ok: false,
      atomic: true,
      failedIndex: 0,
      statements: [{ sql: 'ALTER TABLE posts ENABLE ROW LEVEL SECURITY', ok: false, command: '', rowCount: null, fields: [], rows: [], truncated: false, error: 'relation "posts" does not exist', durationMs: 1, verification: [] }],
    });
    const out = await service.approve('u1', 'x');
    expect(db.apply.mock.calls[0][2][0].sql).toBe('ALTER TABLE posts ENABLE ROW LEVEL SECURITY');
    expect(out.ok).toBe(false);
    expect(out.summary).toContain('Nothing was changed');
  });

  it('keeps the proposal when the database cannot be reached', async () => {
    const { service, proposals, db } = setup(scriptedLlm([]));
    const p = { id: 'x', userId: 'u1', projectId: 'p1', statements: [{ sql: 'SELECT 1' }], validation: null, createdAt: '', expiresAt: '' };
    proposals.take.mockResolvedValue(p);
    db.apply.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.approve('u1', 'x')).rejects.toThrow(/nothing was changed/);
    expect(proposals.restore).toHaveBeenCalledWith(p);
  });
});

describe('history sanitising', () => {
  it('starts with the user, alternates, and ends on the assistant', () => {
    const out = _sanitizeHistoryForTest([
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'system', content: 'ignore me' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: '(no reply)' },
    ]);
  });
});
