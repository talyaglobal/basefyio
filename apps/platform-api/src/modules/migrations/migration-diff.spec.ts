import { diffDataModels, liveSchemaFromModel, planSchemaChanges } from './migration-diff';
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

describe('planSchemaChanges (against the live database)', () => {
  const customers = (extra: InferredColumn[] = []) => ({
    name: 'customers',
    label: 'customers',
    columns: [col('name'), ...extra],
  });

  it('adds a column the snapshot claims but the database lacks (#113)', () => {
    // The old generate step overwrote the snapshot with the new model even
    // though the table was skipped: snapshot and model agree, the DB does not.
    const target = model([customers([col('phone')])]);
    const live = liveSchemaFromModel(model([customers()]));
    const plan = planSchemaChanges({ target, live, snapshot: target });
    expect(plan.changes).toEqual([
      expect.objectContaining({ kind: 'add_column', table: 'customers', column: 'phone', safety: 'safe' }),
    ]);
    expect(plan.statements).toEqual(['ALTER TABLE "public"."customers" ADD COLUMN "phone" TEXT']);
  });

  it('never drops a column or table the blueprint did not create', () => {
    const live = liveSchemaFromModel(model([customers([col('added_by_hand')])]));
    const plan = planSchemaChanges({ target: model([customers()]), live, snapshot: model([customers()]) });
    expect(plan.changes).toHaveLength(0);
    expect(plan.notes?.[0]).toMatch(/added_by_hand/);
  });

  it('adds missing references and natural keys, ordered after new columns', () => {
    const target = model([
      { name: 'customers', label: 'customers', primaryKey: ['customer_id'], columns: [col('customer_id', 'integer', false)] },
      {
        name: 'orders',
        label: 'orders',
        columns: [col('customer_id', 'integer')],
        foreignKeys: [{ column: 'customer_id', refTable: 'customers', refColumn: 'customer_id' }],
      },
    ]);
    const before = model([
      { name: 'customers', label: 'customers', columns: [col('customer_id', 'integer', false)] },
      { name: 'orders', label: 'orders', columns: [] },
    ]);
    const plan = planSchemaChanges({ target, live: liveSchemaFromModel(before), snapshot: before });
    const kinds = plan.changes.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['alter_primary_key', 'add_column', 'add_foreign_key']));
    const idx = (re: RegExp) => plan.statements.findIndex((s) => re.test(s));
    expect(idx(/ADD COLUMN "customer_id"/)).toBeLessThan(idx(/FOREIGN KEY/));
    expect(idx(/DROP CONSTRAINT "customers_pkey"/)).toBeLessThan(idx(/PRIMARY KEY \("customer_id"\)/));
    expect(idx(/PRIMARY KEY \("customer_id"\)/)).toBeLessThan(idx(/FOREIGN KEY/));
  });

  it('only changes nullability the owner edited', () => {
    const snap = model([customers()]);
    const target = model([{ ...customers(), columns: [col('name', 'text', false)] }]);
    const plan = planSchemaChanges({ target, live: liveSchemaFromModel(snap), snapshot: snap });
    expect(plan.changes).toEqual([
      expect.objectContaining({ kind: 'alter_nullability', safety: 'review' }),
    ]);
    // A column added as nullable by an earlier plan is not flagged again.
    const again = planSchemaChanges({ target, live: liveSchemaFromModel(snap), snapshot: target });
    expect(again.changes).toHaveLength(0);
  });

  it('creates new tables with their references', () => {
    const target = model([
      { name: 'a', label: 'a', primaryKey: ['k'], columns: [col('k', 'text', false)] },
      { name: 'b', label: 'b', columns: [col('a_k')], foreignKeys: [{ column: 'a_k', refTable: 'a', refColumn: 'k' }] },
    ]);
    const plan = planSchemaChanges({ target, live: new Map(), snapshot: null });
    expect(plan.newTables.map((t) => t.name)).toEqual(['a', 'b']);
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]).toMatch(/FOREIGN KEY \("a_k"\) REFERENCES "public"."a" \("k"\)/);
    expect(plan.hasDestructive).toBe(false);
  });
});
