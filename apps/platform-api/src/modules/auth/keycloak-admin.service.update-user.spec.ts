import { KeycloakAdminService } from './keycloak-admin.service';

function realmWith(existing: Record<string, unknown>) {
  const update = jest.fn().mockResolvedValue(undefined);
  const svc = new KeycloakAdminService({ get: () => undefined } as any);
  (svc as any).client = { users: { findOne: jest.fn().mockResolvedValue(existing), update } };
  jest.spyOn(svc as any, 'ensureAuth').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'ensureEditUsername').mockResolvedValue(undefined);
  return { svc, update };
}

describe('KeycloakAdminService.updateRealmUser email verification', () => {
  const unconfirmed = { username: 'a@x.io', email: 'a@x.io', emailVerified: false, enabled: true };

  it('keeps an unconfirmed user unconfirmed when the same email is sent back', async () => {
    const { svc, update } = realmWith(unconfirmed);
    await svc.updateRealmUser('r', 'u', { email: 'A@x.io', enabled: false });
    expect(update.mock.calls[0][1]).toMatchObject({ emailVerified: false, enabled: false });
  });

  it('keeps an anonymous user (no email) unconfirmed when an empty email is sent', async () => {
    const { svc, update } = realmWith({ username: 'anon', emailVerified: false, enabled: true });
    await svc.updateRealmUser('r', 'u', { email: '', firstName: 'x' });
    expect(update.mock.calls[0][1].emailVerified).toBe(false);
  });

  it('still confirms a genuinely new address by default', async () => {
    const { svc, update } = realmWith(unconfirmed);
    await svc.updateRealmUser('r', 'u', { email: 'b@x.io' });
    expect(update.mock.calls[0][1]).toMatchObject({ email: 'b@x.io', username: 'b@x.io', emailVerified: true });
  });
});
