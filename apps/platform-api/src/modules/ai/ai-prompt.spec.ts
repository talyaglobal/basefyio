import { buildResultsTurn, buildSystemPrompt, formatSchema, ProjectSchemaSnapshot } from './ai-prompt';

const schema: ProjectSchemaSnapshot = {
  tables: [
    {
      schema: 'public',
      name: 'posts',
      columns: [
        { name: 'id', type: 'bigint', nullable: false, default: null },
        { name: 'owner_id', type: 'text', nullable: false, default: 'auth.uid()' },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      rlsEnabled: true,
      policies: [{ name: 'owners write', command: 'INSERT' }],
      estimatedRows: 3,
    },
    {
      schema: 'public',
      name: 'comments',
      columns: [{ name: 'post_id', type: 'bigint', nullable: true, default: null }],
      primaryKey: [],
      foreignKeys: [{ columns: ['post_id'], references: 'posts(id)' }],
      rlsEnabled: false,
      policies: [],
      estimatedRows: null,
    },
  ],
  authFunctions: [
    { name: 'auth.uid', returns: 'text' },
    { name: 'auth.jwt', returns: 'jsonb' },
  ],
  truncated: false,
  postgresVersion: '16.4',
};

describe('buildSystemPrompt', () => {
  it('carries the live schema, RLS state and the auth helpers', () => {
    const p = buildSystemPrompt({ mode: 'agent', projectName: 'Blog', schema });
    expect(p).toContain('posts(id bigint not null, owner_id text not null default auth.uid())');
    expect(p).toContain('RLS on, 1 policy: owners write (INSERT)');
    expect(p).toContain('comments(post_id bigint) fk(post_id) → posts(id); RLS off');
    expect(p).toContain('auth.uid() returns text');
    expect(p).toContain('PostgreSQL 16.4');
  });

  it('teaches PostgreSQL policy syntax and forbids invented helpers', () => {
    const p = buildSystemPrompt({ mode: 'plan' });
    expect(p).toMatch(/There is no ON UPDATE CURRENT_TIMESTAMP/);
    expect(p).toMatch(/INSERT policies use WITH CHECK only/);
    expect(p).toMatch(/"FOR INSERT, UPDATE" is invalid/);
    expect(p).toMatch(/Never use current_user_id/);
    expect(p).toMatch(/Never hard-code ids/);
  });

  it('tells Agent mode that changes wait for approval and must never be claimed', () => {
    const p = buildSystemPrompt({ mode: 'agent' });
    expect(p).toMatch(/NOT run by you/);
    expect(p).toMatch(/Never say a change has been made/);
    expect(p).toMatch(/Never state that a statement ran/);
  });

  it('describes the whole product, not only PostgreSQL', () => {
    const p = buildSystemPrompt({ mode: 'ask' });
    for (const word of ['Storage', 'Realtime', 'NoSQL', 'Flows', 'Embeddings', 'Authentication']) {
      expect(p.toLowerCase()).toContain(word.toLowerCase());
    }
  });

  it('asks for the user language', () => {
    expect(buildSystemPrompt({ mode: 'ask' })).toMatch(/Reply in the natural language of the user's latest message/);
  });

  it('says so when the schema could not be read instead of letting the model guess', () => {
    const p = buildSystemPrompt({ mode: 'ask', projectName: 'Blog', schemaError: 'timeout' });
    expect(p).toContain('could not be read (timeout)');
  });
});

describe('formatSchema', () => {
  it('cuts the table list to the budget and says so', () => {
    const many: ProjectSchemaSnapshot = {
      ...schema,
      tables: Array.from({ length: 400 }, (_, i) => ({ ...schema.tables[0], name: `t${i}_${'x'.repeat(40)}` })),
    };
    const text = formatSchema(many);
    expect(text.length).toBeLessThan(13_000);
    expect(text).toContain('Schema cut to fit');
  });
});

describe('buildResultsTurn', () => {
  it('passes real results and failures through, and notes pending approvals', () => {
    const t = buildResultsTurn(
      'how many posts?',
      [
        { sql: 'SELECT count(*) FROM posts', ok: true, rowCount: 1, command: 'SELECT', rows: [{ count: 3 }] },
        { sql: 'SELECT nope', ok: false, rowCount: null, command: '', rows: [], error: 'column "nope" does not exist' },
      ],
      1,
    );
    expect(t).toContain('[{"count":3}]');
    expect(t).toContain('Query 2 FAILED');
    expect(t).toContain('NOT been applied');
  });
});
