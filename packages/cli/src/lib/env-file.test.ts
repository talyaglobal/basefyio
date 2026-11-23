import { describe, expect, it } from 'vitest';
import { buildEnvVars, missingEnvHint } from './config';

// The project read no longer carries dbPassword or serviceKey (#14).
const project = {
  id: 'p1',
  slug: 'orders',
  anonKey: 'bf_anon_x',
  dbHost: 'db.example.com',
  dbPort: 6432,
  dbName: 'kb_orders',
  dbUser: 'kb_user_orders',
  keycloakRealm: 'bf-orders',
};
const connect = {
  poolerUri: 'postgresql://kb_user_orders:[YOUR-PASSWORD]@db.example.com:6432/kb_orders',
  uri: 'postgresql://kb_user_orders:[YOUR-PASSWORD]@db.example.com:5432/kb_orders',
};
const API = 'https://api.example.com';

describe('buildEnvVars', () => {
  it('uses the revealed credentials', () => {
    const { vars, missing } = buildEnvVars(project, API, connect, {
      password: 'P@ss word',
      poolerUri: 'postgresql://kb_user_orders:P%40ss%20word@db.example.com:6432/kb_orders',
      uri: 'postgresql://kb_user_orders:P%40ss%20word@db.example.com:5432/kb_orders',
      serviceKey: 'bf_service_x',
    });
    expect(missing).toEqual([]);
    expect(vars.DATABASE_URL).toContain('P%40ss%20word@db.example.com:6432');
    expect(vars.DIRECT_URL).toContain(':5432/');
    expect(vars.BASEFYIO_SERVICE_KEY).toBe('bf_service_x');
    expect(vars.BASEFYIO_DB_PASSWORD).toBe('P@ss word');
  });

  it('fills the masked URIs from the creation response password (basefyio init)', () => {
    const { vars, missing } = buildEnvVars({ ...project, dbPassword: 'P@ss', serviceKey: 'bf_service_y' }, API, connect);
    expect(missing).toEqual([]);
    expect(vars.DATABASE_URL).toBe('postgresql://kb_user_orders:P%40ss@db.example.com:6432/kb_orders');
    expect(vars.BASEFYIO_SERVICE_KEY).toBe('bf_service_y');
  });

  it('never writes a placeholder: unknown credentials are left out and reported', () => {
    const { vars, missing } = buildEnvVars(project, API, connect, null);
    expect(JSON.stringify(vars)).not.toContain('[YOUR-PASSWORD]');
    expect(vars).not.toHaveProperty('DATABASE_URL');
    expect(missing).toEqual(
      expect.arrayContaining(['BASEFYIO_SERVICE_KEY', 'BASEFYIO_DB_PASSWORD', 'DATABASE_URL', 'DIRECT_URL']),
    );
    expect(vars.BASEFYIO_ANON_KEY).toBe('bf_anon_x');
    expect(missingEnvHint(missing)).toContain('database password is hidden');
  });

  it('a used service key is reported, the rest is written', () => {
    const { vars, missing } = buildEnvVars(project, API, connect, {
      password: 'pw',
      poolerUri: 'postgresql://u:pw@h:6432/d',
      uri: 'postgresql://u:pw@h:5432/d',
      serviceKey: null,
    });
    expect(missing).toEqual(['BASEFYIO_SERVICE_KEY']);
    expect(vars.DATABASE_URL).toBe('postgresql://u:pw@h:6432/d');
    expect(missingEnvHint(missing)).toContain('service key is in use');
  });
});
