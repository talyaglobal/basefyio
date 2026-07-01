import { findForbiddenSqlPattern } from './sql-guard';

describe('findForbiddenSqlPattern', () => {
  it('allows ordinary SELECT / DML / DDL', () => {
    expect(findForbiddenSqlPattern('SELECT * FROM customers WHERE id = 1')).toBeNull();
    expect(findForbiddenSqlPattern('UPDATE orders SET status = 1 WHERE id = 2')).toBeNull();
    expect(findForbiddenSqlPattern('CREATE TABLE t (id int)')).toBeNull();
  });

  it('blocks role / database / user statements', () => {
    expect(findForbiddenSqlPattern('DROP DATABASE prod')).toBe('DROP DATABASE');
    expect(findForbiddenSqlPattern('create role hacker')).toBe('CREATE ROLE');
    expect(findForbiddenSqlPattern('GRANT ALL ON t TO x')).toBe('GRANT ');
  });

  it('blocks server-side file / program / FDW access', () => {
    expect(findForbiddenSqlPattern('SELECT pg_read_file(\'/etc/passwd\')')).toBe('pg_read_file');
    expect(findForbiddenSqlPattern('COPY t FROM PROGRAM \'sh\'')).not.toBeNull();
    expect(findForbiddenSqlPattern('SELECT dblink(\'x\',\'y\')')).toBe('DBLINK');
  });

  it('normalizes interspersed comments so a split token is still caught', () => {
    // A real statement obfuscated with an inline comment must still be blocked.
    expect(findForbiddenSqlPattern('DROP/**/DATABASE prod')).toBe('DROP DATABASE');
  });

  it('ignores a forbidden token that lives entirely inside a comment (it never executes)', () => {
    expect(findForbiddenSqlPattern('SELECT 1; /* DROP DATABASE prod */')).toBeNull();
    expect(findForbiddenSqlPattern('SELECT 1 -- DROP ROLE x\n')).toBeNull();
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(findForbiddenSqlPattern('  aLtEr    system SET x=1')).toBe('ALTER SYSTEM');
  });
});
