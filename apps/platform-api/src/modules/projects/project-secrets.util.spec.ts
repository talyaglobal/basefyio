import { shouldOmitProjectSecrets, withoutProjectSecrets } from './project-secrets.util';

describe('project secrets in GET /projects/:id', () => {
  const original = process.env.PROJECT_DETAIL_SECRETS;
  afterEach(() => {
    if (original === undefined) delete process.env.PROJECT_DETAIL_SECRETS;
    else process.env.PROJECT_DETAIL_SECRETS = original;
  });

  it('keeps the old answer by default and omits on request', () => {
    delete process.env.PROJECT_DETAIL_SECRETS;
    expect(shouldOmitProjectSecrets(undefined)).toBe(false);
    expect(shouldOmitProjectSecrets('omit')).toBe(true);
  });

  it('lets the operator omit by default, with an explicit include', () => {
    process.env.PROJECT_DETAIL_SECRETS = 'omit';
    expect(shouldOmitProjectSecrets(undefined)).toBe(true);
    expect(shouldOmitProjectSecrets('include')).toBe(false);
  });

  it('strips the credentials and keeps the public anon key', () => {
    const out = withoutProjectSecrets({
      id: 'p1',
      anonKey: 'anon',
      serviceKey: 'svc',
      dbPassword: 'pw',
      dbReadonlyPassword: 'ro',
    });
    expect(out).toEqual({ id: 'p1', anonKey: 'anon', secretsOmitted: true });
  });
});
