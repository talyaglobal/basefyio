import { KeycloakAdminService } from './keycloak-admin.service';

function build() {
  const update = jest.fn().mockResolvedValue(undefined);
  const findOne = jest.fn();
  const svc = new KeycloakAdminService({ get: () => undefined } as any);
  (svc as any).client = { realms: { update, findOne } };
  jest.spyOn(svc as any, 'ensureAuth').mockResolvedValue(undefined);
  return { svc, update, findOne };
}

describe('KeycloakAdminService realm sleep/wake', () => {
  it('disable sends only {enabled:false}', async () => {
    const { svc, update } = build();
    await svc.disableRealm('r');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ realm: 'r' }, { enabled: false });
  });

  it('enable sends only {enabled:true}', async () => {
    const { svc, update } = build();
    await svc.enableRealm('r');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ realm: 'r' }, { enabled: true });
  });

  it('getRealmState tells enabled, disabled and missing apart', async () => {
    const { svc, findOne } = build();
    findOne.mockResolvedValueOnce({ enabled: true });
    expect(await svc.getRealmState('r')).toBe('enabled');
    findOne.mockResolvedValueOnce({ enabled: false });
    expect(await svc.getRealmState('r')).toBe('disabled');
    findOne.mockResolvedValueOnce(undefined);
    expect(await svc.getRealmState('r')).toBe('missing');
    findOne.mockRejectedValueOnce({ response: { status: 404 } });
    expect(await svc.getRealmState('r')).toBe('missing');
  });

  it('getRealmState throws on a transient failure instead of reporting missing', async () => {
    const { svc, findOne } = build();
    findOne.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(svc.getRealmState('r')).rejects.toThrow('ECONNRESET');
  });
});
