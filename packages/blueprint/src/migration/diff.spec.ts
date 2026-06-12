import { describe, it, expect } from 'vitest';
import { diffDataModels, makeRenameOp } from './diff.js';
import type { DataModel } from '../schemas/data-model.schema.js';

function model(tables: DataModel['tables']): DataModel {
  return { tables, version: 1 };
}

const BASE: DataModel = model([
  {
    name: 'customers',
    displayName: 'Customers',
    fields: [
      { name: 'name', type: 'string', nullable: false, unique: false },
      { name: 'email', type: 'string', nullable: true, unique: true },
      { name: 'age', type: 'number', nullable: true, unique: false },
    ],
  },
  {
    name: 'orders',
    displayName: 'Orders',
    fields: [
      { name: 'amount', type: 'number', nullable: false, unique: false },
      { name: 'status', type: 'string', nullable: true, unique: false },
    ],
  },
]);

// ── Collection changes ────────────────────────────────────────

describe('collection_added', () => {
  it('detects a new collection as SAFE', () => {
    const v2 = model([
      ...BASE.tables,
      { name: 'products', displayName: 'Products', fields: [] },
    ]);
    const plan = diffDataModels(BASE, v2);
    const op = plan.operations.find(o => o.type === 'collection_added');
    expect(op).toBeDefined();
    expect(op!.collection).toBe('products');
    expect(op!.safety).toBe('SAFE');
    expect(plan.hasDestructive).toBe(false);
  });

  it('adding a collection does not produce breaking changes', () => {
    const v2 = model([
      ...BASE.tables,
      { name: 'invoices', displayName: 'Invoices', fields: [] },
    ]);
    expect(diffDataModels(BASE, v2).breakingChanges).toHaveLength(0);
  });
});

describe('collection_removed', () => {
  it('detects a removed collection as DESTRUCTIVE', () => {
    const v2 = model([BASE.tables[0]]); // only customers
    const plan = diffDataModels(BASE, v2);
    const op = plan.operations.find(o => o.type === 'collection_removed' && o.collection === 'orders');
    expect(op).toBeDefined();
    expect(op!.safety).toBe('DESTRUCTIVE');
    expect(plan.hasDestructive).toBe(true);
  });

  it('adds collection name to breakingChanges', () => {
    const v2 = model([BASE.tables[0]]);
    const { breakingChanges } = diffDataModels(BASE, v2);
    expect(breakingChanges.some(b => b.includes('orders'))).toBe(true);
  });
});

// ── Field added ───────────────────────────────────────────────

describe('field_added', () => {
  it('nullable field is SAFE', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: [
          ...BASE.tables[0].fields,
          { name: 'phone', type: 'string', nullable: true, unique: false },
        ],
      },
      BASE.tables[1],
    ]);
    const op = diffDataModels(BASE, v2).operations.find(
      o => o.type === 'field_added' && o.field === 'phone',
    );
    expect(op!.safety).toBe('SAFE');
  });

  it('NOT NULL field is DESTRUCTIVE and adds warning', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: [
          ...BASE.tables[0].fields,
          { name: 'country', type: 'string', nullable: false, unique: false },
        ],
      },
      BASE.tables[1],
    ]);
    const plan = diffDataModels(BASE, v2);
    const op = plan.operations.find(o => o.type === 'field_added' && o.field === 'country');
    expect(op!.safety).toBe('DESTRUCTIVE');
    expect(plan.warnings.some(w => w.includes('country'))).toBe(true);
  });
});

// ── Field removed ─────────────────────────────────────────────

describe('field_removed', () => {
  it('is always DESTRUCTIVE', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: BASE.tables[0].fields.filter(f => f.name !== 'age'),
      },
      BASE.tables[1],
    ]);
    const op = diffDataModels(BASE, v2).operations.find(
      o => o.type === 'field_removed' && o.field === 'age',
    );
    expect(op!.safety).toBe('DESTRUCTIVE');
  });

  it('adds field to breakingChanges', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: BASE.tables[0].fields.filter(f => f.name !== 'email'),
      },
      BASE.tables[1],
    ]);
    const { breakingChanges } = diffDataModels(BASE, v2);
    expect(breakingChanges.some(b => b.includes('email'))).toBe(true);
  });
});

// ── Field type changed ────────────────────────────────────────

describe('field_type_changed', () => {
  it('number → string is POTENTIALLY_SAFE', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: BASE.tables[0].fields.map(f =>
          f.name === 'age' ? { ...f, type: 'string' as const } : f,
        ),
      },
      BASE.tables[1],
    ]);
    const op = diffDataModels(BASE, v2).operations.find(o => o.type === 'field_type_changed');
    expect(op!.safety).toBe('POTENTIALLY_SAFE');
    expect(op!.fromType).toBe('number');
    expect(op!.toType).toBe('string');
  });

  it('string → number is DESTRUCTIVE', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: BASE.tables[0].fields.map(f =>
          f.name === 'name' ? { ...f, type: 'number' as const } : f,
        ),
      },
      BASE.tables[1],
    ]);
    const op = diffDataModels(BASE, v2).operations.find(o => o.type === 'field_type_changed');
    expect(op!.safety).toBe('DESTRUCTIVE');
  });

  it('boolean → text is POTENTIALLY_SAFE', () => {
    const v1 = model([
      {
        name: 'items',
        displayName: 'Items',
        fields: [{ name: 'active', type: 'boolean', nullable: true, unique: false }],
      },
    ]);
    const v2 = model([
      {
        name: 'items',
        displayName: 'Items',
        fields: [{ name: 'active', type: 'text', nullable: true, unique: false }],
      },
    ]);
    const op = diffDataModels(v1, v2).operations.find(o => o.type === 'field_type_changed');
    expect(op!.safety).toBe('POTENTIALLY_SAFE');
  });
});

// ── Index changes ─────────────────────────────────────────────

describe('index_added / index_removed', () => {
  it('adding unique constraint emits index_added (POTENTIALLY_SAFE)', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: BASE.tables[0].fields.map(f =>
          f.name === 'name' ? { ...f, unique: true } : f,
        ),
      },
      BASE.tables[1],
    ]);
    const op = diffDataModels(BASE, v2).operations.find(o => o.type === 'index_added');
    expect(op!.field).toBe('name');
    expect(op!.safety).toBe('POTENTIALLY_SAFE');
  });

  it('removing unique constraint emits index_removed (SAFE)', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: BASE.tables[0].fields.map(f =>
          f.name === 'email' ? { ...f, unique: false } : f,
        ),
      },
      BASE.tables[1],
    ]);
    const op = diffDataModels(BASE, v2).operations.find(o => o.type === 'index_removed');
    expect(op!.field).toBe('email');
    expect(op!.safety).toBe('SAFE');
  });
});

// ── Constraint changed ────────────────────────────────────────

describe('constraint_changed', () => {
  it('adding NOT NULL is DESTRUCTIVE', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: BASE.tables[0].fields.map(f =>
          f.name === 'email' ? { ...f, nullable: false } : f,
        ),
      },
      BASE.tables[1],
    ]);
    const op = diffDataModels(BASE, v2).operations.find(o => o.type === 'constraint_changed');
    expect(op!.safety).toBe('DESTRUCTIVE');
  });

  it('removing NOT NULL is SAFE', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: BASE.tables[0].fields.map(f =>
          f.name === 'name' ? { ...f, nullable: true } : f,
        ),
      },
      BASE.tables[1],
    ]);
    const op = diffDataModels(BASE, v2).operations.find(o => o.type === 'constraint_changed');
    expect(op!.safety).toBe('SAFE');
  });
});

// ── Rename hint ───────────────────────────────────────────────

describe('rename warning', () => {
  it('warns when exactly one field removed and one added in same table', () => {
    const v2 = model([
      {
        ...BASE.tables[0],
        fields: [
          { name: 'full_name', type: 'string', nullable: false, unique: false },
          BASE.tables[0].fields[1],
          BASE.tables[0].fields[2],
        ],
      },
      BASE.tables[1],
    ]);
    const { warnings } = diffDataModels(BASE, v2);
    expect(warnings.some(w => w.includes('rename'))).toBe(true);
  });
});

// ── makeRenameOp ──────────────────────────────────────────────

describe('makeRenameOp', () => {
  it('creates a POTENTIALLY_SAFE field_renamed operation', () => {
    const op = makeRenameOp('customers', 'name', 'full_name');
    expect(op.type).toBe('field_renamed');
    expect(op.safety).toBe('POTENTIALLY_SAFE');
    expect(op.fromField).toBe('name');
    expect(op.toField).toBe('full_name');
  });
});

// ── No-change case ────────────────────────────────────────────

describe('identical models', () => {
  it('returns empty plan for identical models', () => {
    const plan = diffDataModels(BASE, BASE);
    expect(plan.operations).toHaveLength(0);
    expect(plan.hasDestructive).toBe(false);
    expect(plan.breakingChanges).toHaveLength(0);
  });
});
