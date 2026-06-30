import { diffDataModels } from './migration-diff';
import { DataModel } from '../blueprint/blueprint.types';
import { InferredColumn, InferredType } from '../data-import/lib/type-inferrer';

const col = (name: string, type: InferredType = 'text', nullable = true): InferredColumn => ({
  name,
  originalName: name,
  type,
  nullable,
  sampleValues: [],
});
const model = (tables: DataModel['tables']): DataModel => ({ tables });

describe('diffDataModels', () => {
  it('detects a new table as a safe create', () => {
    const plan = diffDataModels(
      model([]),
      model([{ name: 'users', label: 'Users', columns: [col('email')] }]),
    );
    expect(plan.newTables.map((t) => t.name)).toContain('users');
    expect(plan.hasDestructive).toBe(false);
  });

  it('detects a dropped table as destructive', () => {
    const plan = diffDataModels(
      model([{ name: 'old', label: 'old', columns: [col('a')] }]),
      model([]),
    );
    expect(plan.hasDestructive).toBe(true);
    expect(plan.statements.some((s) => /DROP TABLE/i.test(s))).toBe(true);
  });

  it('classifies add (safe), drop (destructive), and type change (review)', () => {
    const from = model([
      { name: 't', label: 't', columns: [col('a', 'text'), col('b', 'integer')] },
    ]);
    const to = model([
      { name: 't', label: 't', columns: [col('a', 'numeric'), col('c', 'text')] },
    ]);
    const plan = diffDataModels(from, to);
    const byKind = (k: string) => plan.changes.find((c) => c.kind === k);
    expect(byKind('add_column')?.safety).toBe('safe');
    expect(byKind('drop_column')?.safety).toBe('destructive');
    expect(byKind('alter_column_type')?.safety).toBe('review');
    expect(plan.hasDestructive).toBe(true);
  });

  it('reports no changes for identical models', () => {
    const m = model([{ name: 't', label: 't', columns: [col('a')] }]);
    const plan = diffDataModels(m, m);
    expect(plan.changes).toHaveLength(0);
    expect(plan.hasDestructive).toBe(false);
  });
});
