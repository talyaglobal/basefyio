import { describe, it, expect } from '@jest/globals';
import { generateMigrationSQL } from './migration-sql';
import type { DataModel, Field } from '@basefyio/blueprint';
import { diffDataModels } from '@basefyio/blueprint';

function model(tables: DataModel['tables']): DataModel {
  return { tables, version: 1 };
}

const V1: DataModel = model([
  {
    name: 'customers',
    displayName: 'Customers',
    fields: [
      { name: 'name', type: 'string', nullable: false, unique: false, primaryKey: false },
      { name: 'email', type: 'string', nullable: true, unique: true, primaryKey: false },
    ],
  },
]);

// ── collection_added ──────────────────────────────────────────

describe('collection_added', () => {
  it('generates CREATE TABLE with id, timestamps', () => {
    const v2 = model([
      ...V1.tables,
      {
        name: 'products',
        displayName: 'Products',
        fields: [
          { name: 'title', type: 'string', nullable: false, unique: false, primaryKey: false },
          { name: 'price', type: 'number', nullable: true, unique: false, primaryKey: false },
        ],
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const createSql = sqls.find(s => s.includes('CREATE TABLE') && s.includes('products'));
    expect(createSql).toBeDefined();
    expect(createSql).toContain('"id" UUID PRIMARY KEY');
    expect(createSql).toContain('"title" text NOT NULL');
    expect(createSql).toContain('"price" numeric');
    expect(createSql).toContain('"created_at"');
    expect(createSql).toContain('"updated_at"');
  });
});

// ── collection_removed ────────────────────────────────────────

describe('collection_removed', () => {
  it('generates DROP TABLE IF EXISTS', () => {
    const v2 = model([]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const dropSql = sqls.find(s => s.includes('DROP TABLE') && s.includes('customers'));
    expect(dropSql).toBeDefined();
    expect(dropSql).toContain('IF EXISTS');
  });
});

// ── field_added ───────────────────────────────────────────────

describe('field_added', () => {
  it('generates ADD COLUMN for nullable field', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: [
          ...V1.tables[0].fields,
          { name: 'phone', type: 'string', nullable: true, unique: false, primaryKey: false },
        ],
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('ADD COLUMN') && s.includes('phone'));
    expect(sql).toBeDefined();
    expect(sql).not.toContain('NOT NULL');
  });

  it('generates ADD COLUMN NOT NULL for non-nullable field', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: [
          ...V1.tables[0].fields,
          { name: 'country', type: 'string', nullable: false, unique: false, primaryKey: false },
        ],
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('ADD COLUMN') && s.includes('country'));
    expect(sql).toContain('NOT NULL');
  });

  it('generates ADD COLUMN with REFERENCES for FK field', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: [
          ...V1.tables[0].fields,
          { name: 'team_id', type: 'uuid', nullable: true, unique: false, primaryKey: false, foreignKey: 'teams' },
        ],
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('team_id'));
    expect(sql).toContain('REFERENCES "teams"(id)');
  });
});

// ── field_removed ─────────────────────────────────────────────

describe('field_removed', () => {
  it('generates DROP COLUMN IF EXISTS', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: V1.tables[0].fields.filter(f => f.name !== 'email'),
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('DROP COLUMN') && s.includes('email'));
    expect(sql).toBeDefined();
    expect(sql).toContain('IF EXISTS');
  });
});

// ── field_type_changed ────────────────────────────────────────

describe('field_type_changed', () => {
  it('generates ALTER COLUMN TYPE with USING cast', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: V1.tables[0].fields.map((f: Field) =>
          f.name === 'name' ? { ...f, type: 'text' as const } : f,
        ),
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('ALTER COLUMN') && s.includes('name'));
    expect(sql).toContain('TYPE text');
    expect(sql).toContain('USING');
  });
});

// ── index_added / index_removed ───────────────────────────────

describe('index_added', () => {
  it('generates CREATE UNIQUE INDEX', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: V1.tables[0].fields.map((f: Field) =>
          f.name === 'name' ? { ...f, unique: true } : f,
        ),
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('CREATE UNIQUE INDEX'));
    expect(sql).toBeDefined();
    expect(sql).toContain('customers_name_unique');
  });
});

describe('index_removed', () => {
  it('generates DROP INDEX IF EXISTS', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: V1.tables[0].fields.map((f: Field) =>
          f.name === 'email' ? { ...f, unique: false } : f,
        ),
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('DROP INDEX'));
    expect(sql).toBeDefined();
    expect(sql).toContain('IF EXISTS');
    expect(sql).toContain('customers_email_unique');
  });
});

// ── constraint_changed ────────────────────────────────────────

describe('constraint_changed', () => {
  it('generates SET NOT NULL when nullable: true → false', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: V1.tables[0].fields.map((f: Field) =>
          f.name === 'email' ? { ...f, nullable: false } : f,
        ),
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('SET NOT NULL'));
    expect(sql).toBeDefined();
  });

  it('generates DROP NOT NULL when nullable: false → true', () => {
    const v2 = model([
      {
        ...V1.tables[0],
        fields: V1.tables[0].fields.map((f: Field) =>
          f.name === 'name' ? { ...f, nullable: true } : f,
        ),
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const sql = sqls.find(s => s.includes('DROP NOT NULL'));
    expect(sql).toBeDefined();
  });
});

// ── ordering ──────────────────────────────────────────────────

describe('ordering', () => {
  it('SAFE operations come before DESTRUCTIVE in output', () => {
    const v2 = model([
      {
        name: 'customers',
        displayName: 'Customers',
        fields: [
          { name: 'name', type: 'string', nullable: false, unique: false, primaryKey: false },
          // email removed (DESTRUCTIVE)
          // phone added nullable (SAFE)
          { name: 'phone', type: 'string', nullable: true, unique: false, primaryKey: false },
        ],
      },
    ]);
    const plan = diffDataModels(V1, v2);
    const sqls = generateMigrationSQL(plan, V1, v2);
    const safeIdx = sqls.findIndex(s => s.includes('[SAFE]'));
    const destIdx = sqls.findIndex(s => s.includes('[DESTRUCTIVE]'));
    if (safeIdx !== -1 && destIdx !== -1) {
      expect(safeIdx).toBeLessThan(destIdx);
    }
  });

  it('empty plan returns no SQL statements', () => {
    const plan = diffDataModels(V1, V1);
    expect(generateMigrationSQL(plan, V1, V1)).toHaveLength(0);
  });
});

// ── identifier safety ─────────────────────────────────────────

describe('identifier safety', () => {
  it('throws on unsafe table name in collection_added', () => {
    const v2 = model([
      ...V1.tables,
      { name: 'bad name!', displayName: 'Bad', fields: [] },
    ]);
    const plan = diffDataModels(V1, v2);
    expect(() => generateMigrationSQL(plan, V1, v2)).toThrow('Unsafe identifier');
  });
});
