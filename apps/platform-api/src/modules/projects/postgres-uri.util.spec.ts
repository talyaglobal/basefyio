import {
  buildPostgresUri,
  encPgPart,
  getPgbouncerClientEndpoints,
  getPostgresDirectClientEndpoints,
} from './postgres-uri.util';

const cfg = (map: Record<string, unknown>) => ({ get: (k: string) => map[k] }) as any;

describe('postgres-uri.util', () => {
  it('percent-encodes user and password so special chars do not break the URI', () => {
    const uri = buildPostgresUri('db.example.com', 6432, 'us er', 'p@ss:w/rd', 'mydb');
    expect(uri).toBe('postgresql://us%20er:p%40ss%3Aw%2Frd@db.example.com:6432/mydb');
  });

  it('builds a plain URI when there is nothing to encode', () => {
    expect(buildPostgresUri('h', 5432, 'u', 'p', 'd')).toBe('postgresql://u:p@h:5432/d');
  });

  it('encPgPart encodes reserved URI characters', () => {
    expect(encPgPart('a@b:c/d')).toBe('a%40b%3Ac%2Fd');
  });

  it('pgbouncer endpoints default to localhost:6432 and honor config', () => {
    expect(getPgbouncerClientEndpoints(cfg({}))).toEqual({ host: 'localhost', port: 6432 });
    expect(
      getPgbouncerClientEndpoints(
        cfg({ 'pgbouncer.externalHost': 'pool', 'pgbouncer.externalPort': 7000 }),
      ),
    ).toEqual({ host: 'pool', port: 7000 });
  });

  it('direct endpoints fall back to the pooler when unset', () => {
    expect(getPostgresDirectClientEndpoints(cfg({}), 'ph', 6432)).toEqual({ host: 'ph', port: 6432 });
    expect(
      getPostgresDirectClientEndpoints(
        cfg({ 'postgresPublic.directHost': 'dh', 'postgresPublic.directPort': 5432 }),
        'ph',
        6432,
      ),
    ).toEqual({ host: 'dh', port: 5432 });
  });
});
