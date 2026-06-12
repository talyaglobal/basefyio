import { generateTableDDL, generateDDL } from './ddl-generator';

describe('generateTableDDL', () => {
  it('generates basic table with id + created_at + updated_at', () => {
    const ddl = generateTableDDL({ name: 'customers', displayName: 'Customers', fields: [
      { name: 'name', type: 'string', nullable: true },
    ]});
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "customers"');
    expect(ddl).toContain('"id" UUID PRIMARY KEY');
    expect(ddl).toContain('"created_at"');
    expect(ddl).toContain('"updated_at"');
    expect(ddl).toContain('"name" text');
  });

  it('maps types correctly', () => {
    const ddl = generateTableDDL({ name: 'orders', displayName: 'Orders', fields: [
      { name: 'amount', type: 'number', nullable: false },
      { name: 'active', type: 'boolean', nullable: true },
      { name: 'customer_id', type: 'uuid', nullable: true, foreignKey: 'customers' },
    ]});
    expect(ddl).toContain('"amount" numeric NOT NULL');
    expect(ddl).toContain('"active" boolean');
    expect(ddl).toContain('"customer_id" UUID REFERENCES "customers"(id)');
  });

  it('adds NOT NULL when nullable is false', () => {
    const ddl = generateTableDDL({ name: 't', displayName: 'T', fields: [
      { name: 'email', type: 'string', nullable: false },
    ]});
    expect(ddl).toContain('"email" text NOT NULL');
  });
});

describe('generateDDL', () => {
  it('puts referenced tables before tables that reference them', () => {
    const ddls = generateDDL([
      { name: 'orders', displayName: 'Orders', fields: [{ name: 'customer_id', type: 'uuid', nullable: true, foreignKey: 'customers' }] },
      { name: 'customers', displayName: 'Customers', fields: [{ name: 'name', type: 'string', nullable: true }] },
    ]);
    // customers should come first (no FKs)
    const custIdx = ddls.findIndex(d => d.includes('"customers"'));
    const ordIdx = ddls.findIndex(d => d.includes('"orders"'));
    expect(custIdx).toBeLessThan(ordIdx);
  });
});
