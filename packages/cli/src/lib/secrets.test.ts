import { describe, expect, it } from 'vitest';
import { resolveProjectSecrets } from './secrets';
import { buildEnvVars, missingEnvHint } from './config';

// The CLI talks to both the current server (POST secrets/reveal, masked reads) and an older
// one (no reveal route; the project read and GET connect still carry the fields).

const httpError = (status: number, message?: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: message ? { message } : {} },
  });

const API = 'https://api.example.com';
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
const maskedConnect = {
  poolerUri: 'postgresql://kb_user_orders:[YOUR-PASSWORD]@db.example.com:6432/kb_orders',
  uri: 'postgresql://kb_user_orders:[YOUR-PASSWORD]@db.example.com:5432/kb_orders',
  password: null,
  serviceKey: null,
};

describe('resolveProjectSecrets', () => {
  it('reveal ok: uses the reveal endpoint', async () => {
    const r = await resolveProjectSecrets(
      async () => ({
        password: 'pw',
        uri: 'postgresql://kb_user_orders:pw@db.example.com:5432/kb_orders',
        poolerUri: 'postgresql://kb_user_orders:pw@db.example.com:6432/kb_orders',
        serviceKey: 'bf_service_new',
        serviceKeyRevealable: true,
      }),
      { project, connect: maskedConnect },
    );
    expect(r.source).toBe('reveal');
    expect(r.message).toBeNull();
    const { vars, missing } = buildEnvVars(project, API, maskedConnect, r.secrets);
    expect(missing).toEqual([]);
    expect(vars.DATABASE_URL).toBe('postgresql://kb_user_orders:pw@db.example.com:6432/kb_orders');
    expect(vars.BASEFYIO_SERVICE_KEY).toBe('bf_service_new');
  });

  it('reveal 404 (older server): falls back to the legacy fields', async () => {
    const legacyProject = { ...project, dbPassword: 'old-pw', serviceKey: 'bf_service_old' };
    const legacyConnect = {
      poolerUri: 'postgresql://kb_user_orders:old-pw@db.example.com:6432/kb_orders',
      uri: 'postgresql://kb_user_orders:old-pw@db.example.com:5432/kb_orders',
      password: 'old-pw',
      serviceKey: 'bf_service_old',
    };
    const r = await resolveProjectSecrets(async () => {
      throw httpError(404);
    }, { project: legacyProject, connect: legacyConnect });
    expect(r).toMatchObject({ source: 'legacy', denied: false, message: null });
    expect(r.secrets).toMatchObject({ password: 'old-pw', serviceKey: 'bf_service_old' });
    const { vars, missing } = buildEnvVars(legacyProject, API, legacyConnect, r.secrets);
    expect(missing).toEqual([]);
    expect(vars.DATABASE_URL).toBe(legacyConnect.poolerUri);
    expect(vars.BASEFYIO_DB_PASSWORD).toBe('old-pw');
  });

  it('reveal 404 with no legacy fields: nothing is invented, .env gets no placeholder, a warning names the gaps', async () => {
    const r = await resolveProjectSecrets(async () => {
      throw httpError(404);
    }, { project, connect: maskedConnect });
    expect(r).toMatchObject({ source: 'none', secrets: null });
    const { vars, missing } = buildEnvVars(project, API, maskedConnect, r.secrets);
    expect(JSON.stringify(vars)).not.toContain('[YOUR-PASSWORD]');
    expect(vars).not.toHaveProperty('DATABASE_URL');
    expect(vars).not.toHaveProperty('BASEFYIO_SERVICE_KEY');
    expect(missing).toEqual(expect.arrayContaining(['BASEFYIO_DB_PASSWORD', 'BASEFYIO_SERVICE_KEY', 'DATABASE_URL']));
    expect(missingEnvHint(missing)).toContain('Not written to .env');
  });

  it('reveal 403: reported as a permission message, not swallowed, and no legacy guess', async () => {
    const r = await resolveProjectSecrets(async () => {
      throw httpError(403, 'Your role cannot see this project\'s credentials.');
    }, { project: { ...project, dbPassword: undefined }, connect: maskedConnect });
    expect(r.denied).toBe(true);
    expect(r.secrets).toBeNull();
    expect(r.message).toMatch(/Your role cannot see this project's credentials/);
    expect(r.message).toMatch(/team owner or admin/);
  });

  it('another failure is reported too', async () => {
    const r = await resolveProjectSecrets(async () => {
      throw httpError(500);
    }, { project });
    expect(r.secrets).toBeNull();
    expect(r.message).toMatch(/Could not fetch the credentials/);
  });
});
