import { grantsPublicWrite, isReadStatement, outcomeSentence } from '../../../admin-ui/lib/agent-sql';

/**
 * Feedback #157 / #158: the AI Agent mode runs a statement by itself only when it
 * is a read (and then over the server's READ ONLY path); every write waits for the
 * user's approval, and the outcome line comes from the real results.
 */
describe('admin-ui agent-sql: what Agent mode may run without asking', () => {
  it.each([
    'SELECT * FROM posts',
    'select count(*) from posts where title = \'drop table\'',
    'WITH t AS (SELECT 1) SELECT * FROM t',
    'EXPLAIN SELECT * FROM posts',
    'SELECT updated_at FROM posts;',
    '-- delete everything\nSELECT 1',
  ])('reads run on their own: %s', (sql) => {
    expect(isReadStatement(sql)).toBe(true);
  });

  it.each([
    'CREATE TABLE posts (id uuid primary key)',
    'INSERT INTO posts (title) VALUES (\'x\')',
    'ALTER TABLE posts ENABLE ROW LEVEL SECURITY',
    'CREATE POLICY p ON posts FOR ALL USING (true)',
    'WITH d AS (DELETE FROM posts RETURNING *) SELECT * FROM d',
    'SELECT * INTO backup FROM posts',
    'SELECT 1; SELECT 2',
    'GRANT SELECT ON posts TO anon',
    'TRUNCATE posts',
    '',
  ])('changes wait for approval: %s', (sql) => {
    expect(isReadStatement(sql)).toBe(false);
  });

  it('flags a policy that lets anyone write', () => {
    expect(grantsPublicWrite('CREATE POLICY p ON posts FOR ALL USING (true)')).toBe(true);
    expect(grantsPublicWrite('CREATE POLICY p ON posts USING (true)')).toBe(true);
    expect(grantsPublicWrite('CREATE POLICY p ON posts FOR INSERT WITH CHECK ( true )')).toBe(true);
    expect(grantsPublicWrite('CREATE POLICY p ON posts FOR SELECT USING (true)')).toBe(false);
    expect(grantsPublicWrite('CREATE POLICY p ON posts FOR UPDATE USING (auth.uid() = owner_id)')).toBe(false);
  });

  it('states failures plainly, whatever the model writes', () => {
    expect(
      outcomeSentence([
        { sql: 'a', status: 'ran' },
        { sql: 'b', status: 'failed', error: 'column "current_user_id" does not exist' },
        { sql: 'c', status: 'skipped' },
      ]),
    ).toBe('3 statements: 1 succeeded, 1 failed and changed nothing, 1 not run because an earlier statement failed.');
    expect(outcomeSentence([{ sql: 'a', error: 'x' }])).toBe('1 statement: 1 failed and changed nothing.');
  });
});
