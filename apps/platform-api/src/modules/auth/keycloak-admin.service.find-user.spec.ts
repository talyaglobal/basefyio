import { KeycloakAdminService } from './keycloak-admin.service';

/**
 * A realm answering lookups the way Keycloak does: `exact: true` compares the whole address,
 * a plain `email` or `search` matches any user whose address merely contains the text.
 */
function realmWith(users: Array<{ id: string; username: string; email?: string }>) {
  const find = jest.fn(async (q: { email?: string; search?: string; exact?: boolean }) => {
    const needle = (q.email ?? q.search ?? '').toLowerCase();
    return users.filter((u) => {
      const values = [u.email ?? '', u.username].map((v) => v.toLowerCase());
      return q.exact ? values[0] === needle : values.some((v) => v.includes(needle));
    });
  });
  const svc = new KeycloakAdminService({ get: () => undefined } as any);
  (svc as any).client = { users: { find } };
  jest.spyOn(svc as any, 'ensureAuth').mockResolvedValue(undefined);
  return svc;
}

describe('KeycloakAdminService.findUserInRealm', () => {
  const bob = { id: 'bob', username: 'bob@example.com', email: 'bob@example.com' };

  it('never answers with another account whose address merely contains the one asked for', async () => {
    // A reset code or magic link for "ob@example.com" was mailed to that address, bound to Bob.
    const svc = realmWith([bob]);
    await expect(svc.findUserInRealm('r', 'ob@example.com')).resolves.toBeNull();
    await expect(svc.findUserInRealm('r', 'example.com')).resolves.toBeNull();
  });

  it('finds the account by its address, whatever the case', async () => {
    const svc = realmWith([bob, { id: 'ob', username: 'ob@example.com', email: 'ob@example.com' }]);
    await expect(svc.findUserInRealm('r', 'BOB@example.com')).resolves.toMatchObject({ id: 'bob' });
    await expect(svc.findUserInRealm('r', 'ob@example.com')).resolves.toMatchObject({ id: 'ob' });
  });

  it('still finds an account whose username is the address but whose email field is empty', async () => {
    const svc = realmWith([{ id: 'legacy', username: 'old@example.com' }]);
    await expect(svc.findUserInRealm('r', 'old@example.com')).resolves.toMatchObject({ id: 'legacy' });
  });
});
