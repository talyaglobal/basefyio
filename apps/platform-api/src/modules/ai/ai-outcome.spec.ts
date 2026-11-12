import { describeOutcome } from './ai-outcome';
import type { ApplyResult } from './ai-database.service';

const stmt = (over: Partial<ApplyResult['statements'][number]>): ApplyResult['statements'][number] => ({
  sql: 'SELECT 1',
  ok: true,
  command: 'SELECT',
  rowCount: 0,
  fields: [],
  rows: [],
  truncated: false,
  durationMs: 1,
  verification: [],
  ...over,
});

describe('describeOutcome', () => {
  it('reports verified changes and real row counts', () => {
    const text = describeOutcome({
      ok: true,
      atomic: true,
      failedIndex: null,
      statements: [
        stmt({ sql: 'ALTER TABLE posts ENABLE ROW LEVEL SECURITY', command: 'ALTER', verification: [{ label: 'Row level security is ON for posts.', passed: true }] }),
        stmt({ sql: 'INSERT INTO posts ...', command: 'INSERT', rowCount: 3 }),
      ],
    });
    expect(text).toContain('Applied 2 statements');
    expect(text).toContain('✓ Row level security is ON for posts.');
    expect(text).toContain('3 rows inserted');
    expect(text).not.toContain('returned');
  });

  it('says nothing changed when an atomic script failed', () => {
    const text = describeOutcome({
      ok: false,
      atomic: true,
      failedIndex: 1,
      statements: [
        stmt({ command: 'ALTER', verification: [] }),
        stmt({ ok: false, error: 'column "current_user_id" does not exist' }),
      ],
    });
    expect(text).toContain('Nothing was changed');
    expect(text).toContain('Statement 2 failed');
    expect(text).toContain('current_user_id');
    expect(text).not.toMatch(/Applied/);
  });

  it('reports a partial run when the script could not be atomic', () => {
    const text = describeOutcome({
      ok: false,
      atomic: false,
      failedIndex: 1,
      statements: [stmt({ command: 'CREATE INDEX' }), stmt({ ok: false, error: 'boom' })],
    });
    expect(text).toContain('Partly applied');
  });

  it('warns when a statement ran but the catalog does not match', () => {
    const text = describeOutcome({
      ok: false,
      atomic: true,
      failedIndex: null,
      statements: [stmt({ command: 'CREATE POLICY', verification: [{ label: 'Policy "p" does not exist on posts.', passed: false }] })],
    });
    expect(text).toContain('✗ Policy "p" does not exist on posts.');
    expect(text).toContain('Warning');
  });
});
