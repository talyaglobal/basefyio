import { KeycloakAdminService } from './keycloak-admin.service';
import { assertPolicyBody } from '../projects/project-auth-limits';

function build() {
  const update = jest.fn().mockResolvedValue(undefined);
  const findOne = jest.fn();
  const svc = new KeycloakAdminService({ get: () => undefined } as any);
  (svc as any).client = { realms: { update, findOne } };
  jest.spyOn(svc as any, 'ensureAuth').mockResolvedValue(undefined);
  return { svc, update, findOne };
}

/** #246: single-use refresh tokens are a per-project opt-in on the realm. */
describe('single-use refresh tokens (realm policies)', () => {
  it('reads as on only with revoke on and max reuse 0', async () => {
    const { svc, findOne } = build();
    findOne.mockResolvedValueOnce({ revokeRefreshToken: true, refreshTokenMaxReuse: 0 });
    expect((await svc.getRealmPolicies('r')).revokeRefreshToken).toBe(true);
    findOne.mockResolvedValueOnce({ revokeRefreshToken: true, refreshTokenMaxReuse: 2 });
    expect((await svc.getRealmPolicies('r')).revokeRefreshToken).toBe(false);
    findOne.mockResolvedValueOnce({});
    expect((await svc.getRealmPolicies('r')).revokeRefreshToken).toBe(false);
  });

  it('writes both realm fields and nothing it was not given', async () => {
    const { svc, update } = build();
    await svc.updateRealmPolicies('r', { revokeRefreshToken: true, refreshTokenMaxReuse: 0, unrelated: 1 });
    expect(update).toHaveBeenCalledWith({ realm: 'r' }, { revokeRefreshToken: true, refreshTokenMaxReuse: 0 });
  });

  it('leaves the realm untouched when the body does not mention it', async () => {
    const { svc, update } = build();
    await svc.updateRealmPolicies('r', { failureFactor: 5 });
    expect(update).toHaveBeenCalledWith({ realm: 'r' }, { failureFactor: 5 });
  });

  it('accepts only a boolean', () => {
    expect(() => assertPolicyBody({ revokeRefreshToken: true })).not.toThrow();
    expect(() => assertPolicyBody({ revokeRefreshToken: 'yes' })).toThrow('revokeRefreshToken must be true or false');
  });
});
