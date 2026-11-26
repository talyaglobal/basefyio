/**
 * Social sign-in without Keycloak pages (customer report on realm kb-payfyio_cloud): names
 * optional, VERIFY_PROFILE off, first-broker-login review off, Google/GitHub trusting the
 * address, no fixed prompt in the provider config — for new realms and, idempotently, old ones.
 */
jest.mock('axios');

import axios from 'axios';
import {
  KeycloakAdminService,
  TRUST_EMAIL_CHOICE_KEY,
  healIdentityProviderRepresentation,
  relaxUserProfileNames,
  socialNameMappers,
} from './keycloak-admin.service';

const mockedAxios = axios as jest.Mocked<typeof axios>;

const config = {
  get: (k: string) =>
    ({
      'keycloak.url': 'http://kc:8080',
      'keycloak.adminClientId': 'admin-cli',
      'keycloak.adminUser': 'admin',
      'keycloak.adminPassword': 'admin',
    })[k],
};

function service(client: Record<string, any> = {}) {
  const svc = new KeycloakAdminService(config as any);
  (svc as any).client = client;
  jest.spyOn(svc as any, 'ensureAuth').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'getAdminAccessToken').mockResolvedValue('admin-token');
  jest.spyOn(svc, 'ensureAutoLinkFlow').mockResolvedValue('auto-link-broker');
  return svc;
}

const BASE = 'http://kc:8080/admin/realms/r1';

/** A realm as Keycloak 24 creates it, with one GitHub provider made before this change. */
function legacyRealm() {
  return {
    [`${BASE}/users/profile`]: {
      unmanagedAttributePolicy: 'ADMIN_EDIT',
      attributes: [
        { name: 'username' },
        { name: 'email', required: { roles: ['user'] } },
        { name: 'firstName', required: { roles: ['user'] }, permissions: { view: ['admin', 'user'] } },
        { name: 'lastName', required: { roles: ['user'] } },
      ],
    },
    [`${BASE}/authentication/required-actions/VERIFY_PROFILE`]: {
      alias: 'VERIFY_PROFILE',
      enabled: true,
      defaultAction: false,
    },
    [`${BASE}/authentication/flows/first%20broker%20login/executions`]: [
      { id: 'ex-review', providerId: 'idp-review-profile', authenticationConfig: 'cfg-review' },
      { id: 'ex-create', providerId: 'idp-create-user-if-unique' },
    ],
    [`${BASE}/authentication/config/cfg-review`]: {
      id: 'cfg-review',
      alias: 'review profile config',
      config: { 'update.profile.on.first.login': 'missing' },
    },
    [`${BASE}/identity-provider/instances`]: [{ alias: 'github' }, { alias: 'google' }],
    [`${BASE}/identity-provider/instances/github`]: {
      alias: 'github',
      providerId: 'github',
      trustEmail: false,
      firstBrokerLoginFlowAlias: 'first broker login',
      config: { clientId: 'gh', clientSecret: 's', prompt: 'login', max_age: '0' },
    },
    [`${BASE}/identity-provider/instances/google`]: {
      alias: 'google',
      providerId: 'google',
      trustEmail: true,
      firstBrokerLoginFlowAlias: 'auto-link-broker',
      config: { clientId: 'go', clientSecret: 's', prompt: 'select_account login', max_age: '0' },
    },
    [`${BASE}/identity-provider/instances/github/mappers`]: [],
    [`${BASE}/identity-provider/instances/google/mappers`]: [],
  } as Record<string, any>;
}

/** Axios against an in-memory realm: GET reads, PUT replaces, POST to mappers appends. */
function fakeKeycloak(store: Record<string, any>) {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (!(url in store)) throw Object.assign(new Error('404'), { response: { status: 404 } });
    return { data: JSON.parse(JSON.stringify(store[url])) };
  });
  mockedAxios.put.mockImplementation(async (url: string, body: any) => {
    store[url] = body;
    return { data: undefined };
  });
  mockedAxios.post.mockImplementation(async (url: string, body: any) => {
    if (Array.isArray(store[url])) store[url].push(body);
    else store[url] = body;
    return { data: undefined };
  });
}

beforeEach(() => jest.resetAllMocks());

describe('relaxUserProfileNames', () => {
  it('drops `required` from firstName and lastName only', () => {
    const { changed, profile } = relaxUserProfileNames(legacyRealm()[`${BASE}/users/profile`]);
    expect(changed).toBe(true);
    const by = Object.fromEntries(profile.attributes.map((a: any) => [a.name, a]));
    expect(by.firstName.required).toBeUndefined();
    expect(by.firstName.permissions).toEqual({ view: ['admin', 'user'] });
    expect(by.lastName.required).toBeUndefined();
    expect(by.email.required).toEqual({ roles: ['user'] });
    expect(profile.unmanagedAttributePolicy).toBe('ADMIN_EDIT');
  });

  it('reports no change for a profile already relaxed', () => {
    const once = relaxUserProfileNames(legacyRealm()[`${BASE}/users/profile`]).profile;
    expect(relaxUserProfileNames(once).changed).toBe(false);
  });
});

describe('healIdentityProviderRepresentation', () => {
  it('sets the auto-link flow, trusts GitHub/Google addresses and removes the fixed prompt', () => {
    const { changed, idp } = healIdentityProviderRepresentation(
      legacyRealm()[`${BASE}/identity-provider/instances/github`],
      'auto-link-broker',
    );
    expect(changed).toBe(true);
    expect(idp).toMatchObject({ trustEmail: true, firstBrokerLoginFlowAlias: 'auto-link-broker' });
    expect(idp.config).toEqual({ clientId: 'gh', clientSecret: 's' });
  });

  it('keeps "trust email" off when the project chose that', () => {
    const { idp } = healIdentityProviderRepresentation(
      { alias: 'google', trustEmail: false, firstBrokerLoginFlowAlias: 'auto-link-broker', config: { [TRUST_EMAIL_CHOICE_KEY]: 'false' } },
      'auto-link-broker',
    );
    expect(idp.trustEmail).toBe(false);
  });

  it('leaves the e-mail trust of other providers alone', () => {
    const { changed } = healIdentityProviderRepresentation(
      { alias: 'twitter', trustEmail: false, firstBrokerLoginFlowAlias: 'auto-link-broker', config: { prompt: 'x' } },
      'auto-link-broker',
    );
    expect(changed).toBe(false);
  });
});

describe('socialNameMappers', () => {
  it('maps Google given_name/family_name and needs nothing for GitHub', () => {
    expect(socialNameMappers('google').map((m) => [m.config.claim, m.config['user.attribute']])).toEqual([
      ['given_name', 'firstName'],
      ['family_name', 'lastName'],
    ]);
    expect(socialNameMappers('github')).toEqual([]);
  });
});

describe('ensureSocialLoginProfile', () => {
  it('heals a legacy realm and changes nothing the second time', async () => {
    const store = legacyRealm();
    fakeKeycloak(store);
    const svc = service();

    expect(await svc.ensureSocialLoginProfile('r1')).toEqual([]);

    const profile = store[`${BASE}/users/profile`];
    expect(profile.attributes.find((a: any) => a.name === 'lastName').required).toBeUndefined();
    expect(store[`${BASE}/authentication/required-actions/VERIFY_PROFILE`]).toMatchObject({ enabled: false, defaultAction: false });
    expect(store[`${BASE}/authentication/config/cfg-review`].config['update.profile.on.first.login']).toBe('off');
    expect(store[`${BASE}/identity-provider/instances/github`]).toMatchObject({
      trustEmail: true,
      firstBrokerLoginFlowAlias: 'auto-link-broker',
      config: { clientId: 'gh', clientSecret: 's' },
    });
    expect(store[`${BASE}/identity-provider/instances/google`].config.prompt).toBeUndefined();
    expect(store[`${BASE}/identity-provider/instances/google/mappers`].map((m: any) => m.name)).toEqual([
      'given_name-to-firstName',
      'family_name-to-lastName',
    ]);

    const writes = mockedAxios.put.mock.calls.length + mockedAxios.post.mock.calls.length;
    expect(await svc.ensureSocialLoginProfile('r1')).toEqual([]);
    expect(mockedAxios.put.mock.calls.length + mockedAxios.post.mock.calls.length).toBe(writes);
  });

  it('reports a failing step and still runs the others', async () => {
    const store = legacyRealm();
    delete store[`${BASE}/users/profile`];
    fakeKeycloak(store);
    mockedAxios.get.mockImplementationOnce(async () => {
      throw Object.assign(new Error('boom'), { response: { status: 500, data: { errorMessage: 'boom' } } });
    });
    const problems = await service().ensureSocialLoginProfile('r1');
    expect(problems).toEqual(['user profile: boom']);
    expect(store[`${BASE}/authentication/required-actions/VERIFY_PROFILE`].enabled).toBe(false);
  });
});

describe('upsertIdentityProvider', () => {
  it('creates GitHub trusting the address, on the auto-link flow, with no fixed prompt', async () => {
    const store: Record<string, any> = {};
    fakeKeycloak(store);
    const svc = service();
    jest.spyOn(svc, 'ensureSocialLoginProfile').mockResolvedValue([]);
    await svc.upsertIdentityProvider('r1', 'github', 'gh', 'secret', 'unused');
    const body = mockedAxios.post.mock.calls[0][1] as any;
    expect(body).toMatchObject({ alias: 'github', trustEmail: true, firstBrokerLoginFlowAlias: 'auto-link-broker' });
    expect(body.config.prompt).toBeUndefined();
    expect(body.config.max_age).toBeUndefined();
    expect(svc.ensureSocialLoginProfile).toHaveBeenCalledWith('r1');
  });

  it('records trustEmail=false and keeps it on a later save that does not say', async () => {
    const store: Record<string, any> = {};
    fakeKeycloak(store);
    const svc = service();
    jest.spyOn(svc, 'ensureSocialLoginProfile').mockResolvedValue([]);
    await svc.upsertIdentityProvider('r1', 'google', 'go', 'secret', 'unused', { trustEmail: false });
    const created = mockedAxios.post.mock.calls[0][1] as any;
    expect(created.trustEmail).toBe(false);
    expect(created.config[TRUST_EMAIL_CHOICE_KEY]).toBe('false');

    store[`${BASE}/identity-provider/instances/google`] = created;
    await svc.upsertIdentityProvider('r1', 'google', 'go', 'secret', 'unused');
    const updated = mockedAxios.put.mock.calls[0][1] as any;
    expect(updated.trustEmail).toBe(false);
  });
});

describe('ensureAnonClientPostLogoutRedirectUri', () => {
  it('adds the logout callback once and keeps what was there', async () => {
    const existing = { id: 'c1', clientId: 'r1-anon', attributes: { 'post.logout.redirect.uris': '+' } };
    const update = jest.fn().mockResolvedValue(undefined);
    const find = jest.fn().mockResolvedValue([existing]);
    const svc = service({ clients: { find, update } });
    await svc.ensureAnonClientPostLogoutRedirectUri('r1', 'https://api.example.com/api/rest/v1/auth/logout-callback/p1');
    expect(update.mock.calls[0][1].attributes['post.logout.redirect.uris']).toBe(
      '+##https://api.example.com/api/rest/v1/auth/logout-callback/p1',
    );

    find.mockResolvedValue([{ ...existing, attributes: update.mock.calls[0][1].attributes }]);
    await svc.ensureAnonClientPostLogoutRedirectUri('r1', 'https://api.example.com/api/rest/v1/auth/logout-callback/p1');
    expect(update).toHaveBeenCalledTimes(1);
  });
});
