jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('./project-mfa.service', () => ({ ProjectMfaService: class {} }));
import { ProjectAuthController, withPolicyLength } from './project-auth.controller';

/** #17: one password minimum for the project, whichever screen sets it. */
describe('withPolicyLength', () => {
  it('sets the length and keeps every other rule', () => {
    expect(withPolicyLength('length(4) and upperCase(1) and passwordHistory(3)', 8)).toBe(
      'length(8) and upperCase(1) and passwordHistory(3)',
    );
    expect(withPolicyLength('', 6)).toBe('length(6)');
    expect(withPolicyLength('digits(1)', 10)).toBe('length(10) and digits(1)');
  });
});

describe('ProjectAuthController password minimum sync', () => {
  function build(realmPolicy = 'upperCase(1)', cfgMin = 6) {
    const keycloak = {
      getRealmPolicies: jest.fn(async () => ({ passwordPolicy: realmPolicy, bruteForceProtected: true })),
      updateRealmPolicies: jest.fn(async () => ({})),
      setRealmAccessTokenLifespan: jest.fn(async () => undefined),
    };
    const authConfigService = {
      getOrCreate: jest.fn(async () => ({ minPasswordLength: cfgMin })),
      update: jest.fn(async (_p: string, d: any) => ({ minPasswordLength: d.minPasswordLength ?? cfgMin })),
    };
    const ctrl = Object.create(ProjectAuthController.prototype) as any;
    Object.assign(ctrl, {
      projectsService: { findOne: jest.fn(async () => ({ keycloakRealm: 'r1' })) },
      keycloak,
      authConfigService,
      activity: { append: jest.fn(async () => undefined) },
    });
    return { ctrl, keycloak, authConfigService };
  }

  it('Policies shows the project minimum even when the realm has none', async () => {
    const { ctrl } = build('upperCase(1)', 6);
    const r = await ctrl.getPolicies('p1');
    expect(r.password.minLength).toBe(6);
    expect(r.password.requireUppercase).toBe(true);
  });

  it('saving Settings writes the minimum to the realm too, keeping its other rules', async () => {
    const { ctrl, keycloak } = build('upperCase(1)', 6);
    await ctrl.updateConfig('p1', { minPasswordLength: 9 });
    expect(keycloak.updateRealmPolicies).toHaveBeenCalledWith('r1', { passwordPolicy: 'length(9) and upperCase(1)' });
  });

  it('saving Policies writes the minimum to the auth config too', async () => {
    const { ctrl, authConfigService } = build();
    await ctrl.updatePolicies('p1', { password: { minLength: 12 } });
    expect(authConfigService.update).toHaveBeenCalledWith('p1', { minPasswordLength: 12 }, undefined);
  });
});
