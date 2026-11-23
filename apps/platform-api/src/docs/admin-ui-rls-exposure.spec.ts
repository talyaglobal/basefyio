import { exposureWarning } from '../../../admin-ui/lib/rls-policies';

/** #251: a table with RLS off says plainly who can read or change it. */
const table = (rlsEnabled: boolean, access?: Partial<Record<'anonRead' | 'anonWrite' | 'authenticatedRead' | 'authenticatedWrite', boolean>>) => ({
  schema: 'public',
  name: 't',
  rlsEnabled,
  rlsForced: false,
  policies: [],
  access: access && { anonRead: false, anonWrite: false, authenticatedRead: false, authenticatedWrite: false, ...access },
});

describe('admin-ui exposureWarning', () => {
  it('warns that the public key reads every row (the default grants)', () => {
    expect(exposureWarning(table(false, { anonRead: true, authenticatedRead: true, authenticatedWrite: true }))).toBe(
      'Row-level security is off: anyone with your public (anon) key can read every row, and any signed-in user can change every row.',
    );
  });

  it('says read and change when the public key can do both', () => {
    expect(exposureWarning(table(false, { anonRead: true, anonWrite: true }))).toContain('can read and change every row');
  });

  it('is silent with RLS on, with no grants, or on an older server', () => {
    expect(exposureWarning(table(true, { anonRead: true }))).toBeNull();
    expect(exposureWarning(table(false, {}))).toBeNull();
    expect(exposureWarning(table(false))).toBeNull();
  });
});
