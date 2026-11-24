import { KeycloakAdminService } from './keycloak-admin.service';

/** A realm of `count` users served the way Keycloak pages them (`first`, `max`, default 100). */
function realmOf(count: number) {
  const all = Array.from({ length: count }, (_, i) => ({ id: `u${i}`, username: `user${i}`, email: `user${i}@example.test` }));
  const find = jest.fn(async (q: { first?: number; max?: number; search?: string }) => {
    const matching = q.search ? all.filter((u) => u.email.includes(q.search!)) : all;
    const first = q.first ?? 0;
    return matching.slice(first, first + (q.max ?? 100));
  });
  const svc = new KeycloakAdminService({ get: () => undefined } as any);
  (svc as any).client = { users: { find } };
  jest.spyOn(svc as any, 'ensureAuth').mockResolvedValue(undefined);
  return { svc, find };
}

describe('KeycloakAdminService.listUsers paging and search', () => {
  it('asks for an explicit page of 100 by default', async () => {
    const { svc, find } = realmOf(250);
    const users = await svc.listUsers('r1');
    expect(users).toHaveLength(100);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ realm: 'r1', first: 0, max: 100 }));
  });

  it('passes the search and the page through, capping the page at 500', async () => {
    const { svc, find } = realmOf(10);
    await svc.listUsers('r1', { search: '  user7  ', first: 3, max: 10_000 });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ search: 'user7', first: 3, max: 500 }));
  });

  it('?email= is an exact, case-insensitive match, never a partial one', async () => {
    const { svc, find } = realmOf(30);
    // Keycloak's own exact flag is asked for; a looser answer is filtered again here.
    find.mockResolvedValueOnce([
      { id: 'u1', username: 'user1', email: 'user1@example.test' },
      { id: 'u11', username: 'user11', email: 'user11@example.test' },
    ]);
    const users = await svc.listUsers('r1', { email: ' USER1@Example.test ', search: 'ignored' });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ email: 'user1@example.test', exact: true }));
    expect(find.mock.calls[0][0]).not.toHaveProperty('search');
    expect(users.map((u) => u.id)).toEqual(['u1']);
  });

  it('sends no search for an empty one', async () => {
    const { svc, find } = realmOf(1);
    await svc.listUsers('r1', { search: '   ' });
    expect(find.mock.calls[0][0]).not.toHaveProperty('search');
  });

  it('listAllUsers returns every user across pages, for exports', async () => {
    const { svc, find } = realmOf(1203);
    const users = await svc.listAllUsers('r1');
    expect(users).toHaveLength(1203);
    expect(new Set(users.map((u) => u.id)).size).toBe(1203);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('listAllUsers stops after an exactly full last page', async () => {
    const { svc, find } = realmOf(500);
    expect(await svc.listAllUsers('r1')).toHaveLength(500);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
