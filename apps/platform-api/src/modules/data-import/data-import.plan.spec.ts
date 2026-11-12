import { validateImportPlan, type TableShape } from './data-import.service';
import { buildCreateTableSQL, isRowLocalError } from './data-import.processor';

const col = (source: string, target: string, type: any = 'text', nullable = true) => ({
  source,
  target,
  type,
  nullable,
});

describe('import plan validation', () => {
  const table: TableShape = {
    schema: 'public',
    columns: new Set(['id', 'full_name', 'amount']),
    uniqueSets: [['id']],
  };

  it('accepts a mapping onto existing columns with the primary key as conflict column', () => {
    expect(
      validateImportPlan(
        {
          targetMode: 'existing',
          tableName: 'people',
          conflictMode: 'update',
          conflictColumns: ['id'],
          columns: [col('ID', 'id', 'integer'), col('Full Name', 'full_name'), col('amount', 'amount', 'numeric')],
        },
        table,
      ),
    ).toEqual([]);
  });

  it('names columns that do not exist instead of letting the job fail later', () => {
    const errors = validateImportPlan(
      {
        targetMode: 'existing',
        tableName: 'people',
        conflictMode: 'fail',
        columns: [col('ID', 'id'), col('extra_col', 'extra_col')],
      },
      table,
    );
    expect(errors.join(' ')).toMatch(/"extra_col" does not exist/);
  });

  it('refuses skip/update on columns without a unique constraint', () => {
    const errors = validateImportPlan(
      {
        targetMode: 'existing',
        tableName: 'people',
        conflictMode: 'skip',
        conflictColumns: ['full_name'],
        columns: [col('Full Name', 'full_name')],
      },
      table,
    );
    expect(errors.join(' ')).toMatch(/primary key or unique constraint/);
  });

  it('catches two sources mapped to one column and invalid names', () => {
    const errors = validateImportPlan(
      {
        targetMode: 'new',
        tableName: 'bad-name',
        conflictMode: 'fail',
        columns: [col('a', 'x'), col('b', 'x'), col('c', '1abc')],
      },
      null,
    );
    expect(errors.join(' ')).toMatch(/both mapped to column "x"/);
    expect(errors.join(' ')).toMatch(/not a valid table name/);
    expect(errors.join(' ')).toMatch(/"1abc".*not a valid column name/);
  });

  it('refuses to create a table that already exists', () => {
    const errors = validateImportPlan(
      { targetMode: 'new', tableName: 'people', conflictMode: 'fail', columns: [col('a', 'a')] },
      table,
    );
    expect(errors.join(' ')).toMatch(/already exists/);
  });
});

describe('new-table DDL', () => {
  it('uses a mapped id column as the primary key instead of adding a second id', () => {
    const sql = buildCreateTableSQL(
      'public',
      'cities',
      [col('id', 'id', 'integer', false), col('ad', 'ad'), col('şehir', 'sehir')],
      'fail',
      [],
    );
    expect(sql).toContain('"id" integer PRIMARY KEY');
    expect(sql).not.toContain('SERIAL');
    expect(sql.match(/"id"/g)).toHaveLength(1);
  });

  it('adds a serial id when the file has none, and NOT NULL only where asked', () => {
    const sql = buildCreateTableSQL(
      'public',
      't',
      [col('a', 'a', 'text', true), col('b', 'b', 'integer', false)],
      'fail',
      [],
    );
    expect(sql).toContain('"id" SERIAL PRIMARY KEY');
    expect(sql).toContain('"a" text,');
    expect(sql).toContain('"b" integer NOT NULL');
  });

  it('gives skip/update a UNIQUE constraint on the conflict columns', () => {
    const sql = buildCreateTableSQL('public', 't', [col('email', 'email')], 'skip', ['email']);
    expect(sql).toContain('UNIQUE ("email")');
    const pk = buildCreateTableSQL('public', 't', [col('id', 'id', 'integer')], 'update', ['id']);
    expect(pk).not.toContain('UNIQUE');
  });
});

describe('row-local database errors', () => {
  it('retries row by row for data, constraint and duplicate-key-in-batch errors only', () => {
    expect(isRowLocalError('22P02')).toBe(true); // invalid text representation
    expect(isRowLocalError('23505')).toBe(true); // unique violation
    expect(isRowLocalError('21000')).toBe(true); // ON CONFLICT DO UPDATE hit a row twice
    expect(isRowLocalError('42703')).toBe(false); // undefined column: a broken plan
    expect(isRowLocalError(undefined)).toBe(false);
  });
});
