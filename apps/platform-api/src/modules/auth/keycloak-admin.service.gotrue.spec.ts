/**
 * The Keycloak side of the GoTrue facade (docs/specs/supabase-compat-auth.md §5, §6, §9):
 * the claim mappers a project's public clients carry, the metadata attributes written on a
 * user, the token lifetime setting, and session minting through impersonation.
 *
 * The admin client is a double; HTTP calls the service makes itself go through a mocked axios.
 */
jest.mock('axios');

import axios from 'axios';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  DEFAULT_APP_METADATA,
  KeycloakAdminService,
  goTrueClientMappers,
  realmPublicClientId,
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

function service(client: Record<string, any>) {
  const svc = new KeycloakAdminService(config as any);
  (svc as any).client = client;
  jest.spyOn(svc as any, 'ensureAuth').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'ensureUnmanagedAttributes').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'getAdminAccessToken').mockResolvedValue('admin-token');
  return svc;
}

const byName = (mappers: Array<{ name: string }>) => Object.fromEntries(mappers.map((m) => [m.name, m]));

describe('goTrueClientMappers', () => {
  it('names every claim a GoTrue client reads, as JSON attributes and hardcoded values', () => {
    const m = byName(goTrueClientMappers('aal1')) as Record<string, any>;
    expect(m.app_metadata.config).toMatchObject({
      'user.attribute': 'app_metadata',
      'jsonType.label': 'JSON',
      'access.token.claim': 'true',
      'userinfo.token.claim': 'true',
    });
    expect(m.user_metadata.config['user.attribute']).toBe('user_metadata');
    expect(m.role.config).toMatchObject({ 'claim.value': 'authenticated' });
    expect(m.aal.config).toMatchObject({ 'claim.value': 'aal1' });
    expect(m['aud-authenticated'].config['included.custom.audience']).toBe('authenticated');
    expect(m.phone.config).toMatchObject({ 'user.attribute': 'phoneNumber', 'claim.name': 'phone' });
    expect(m.amr).toBeUndefined();
  });

  it('the aal2 client says aal2 and lists the totp method in amr', () => {
    const m = byName(goTrueClientMappers('aal2')) as Record<string, any>;
    expect(m.aal.config['claim.value']).toBe('aal2');
    expect(m.amr.config).toMatchObject({ 'claim.value': '[{"method":"totp"}]', 'jsonType.label': 'JSON' });
  });

  it('names the two public clients of a realm', () => {
    expect(realmPublicClientId('r1')).toBe('r1-anon');
    expect(realmPublicClientId('r1', 'aal2')).toBe('r1-anon-aal2');
  });
});

describe('createClients', () => {
  it('creates the anon client with the GoTrue mappers and its aal2 twin', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'c' });
    const svc = service({ clients: { create } });
    await svc.createClients('r1');
    const created = create.mock.calls.map((c) => c[0]);
    const anon = created.find((c) => c.clientId === 'r1-anon');
    const aal2 = created.find((c) => c.clientId === 'r1-anon-aal2');
    expect(anon.protocolMappers.map((m: any) => m.name)).toEqual(
      expect.arrayContaining(['auth_time', 'app_metadata', 'user_metadata', 'role', 'aal', 'aud-authenticated', 'phone']),
    );
    expect(aal2.publicClient).toBe(true);
    expect(aal2.protocolMappers.map((m: any) => m.name)).toEqual(expect.arrayContaining(['aal', 'amr']));
    expect(created.find((c) => c.clientId === 'r1-service')).toBeDefined();
  });
});

describe('ensureRealmClientGoTrueMappers', () => {
  it('adds only the mappers a legacy client lacks, once per process', async () => {
    const addProtocolMapper = jest.fn().mockResolvedValue(undefined);
    const svc = service({
      clients: {
        find: jest.fn().mockResolvedValue([{ id: 'cid', clientId: 'r1-anon' }]),
        listProtocolMappers: jest.fn().mockResolvedValue([{ name: 'auth_time' }, { name: 'role' }]),
        addProtocolMapper,
      },
    });
    await svc.ensureRealmClientGoTrueMappers('r1', 'r1-anon');
    await svc.ensureRealmClientGoTrueMappers('r1', 'r1-anon');
    const added = addProtocolMapper.mock.calls.map((c) => c[1].name);
    expect(added).toEqual(['app_metadata', 'user_metadata', 'aal', 'aud-authenticated', 'phone']);
  });

  it('creates the aal2 client of a realm that predates it', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'new' });
    const find = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'new', clientId: 'r1-anon-aal2' }]);
    const svc = service({
      clients: {
        find,
        create,
        listProtocolMappers: jest.fn().mockResolvedValue(goTrueClientMappers('aal2')),
        addProtocolMapper: jest.fn(),
      },
    });
    await svc.ensureRealmClientGoTrueMappers('r1', 'r1-anon-aal2');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'r1-anon-aal2' }));
  });
});

describe('user metadata attributes', () => {
  it('createProjectUser writes default app_metadata and the given user_metadata as JSON, password optional', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'u1' });
    const svc = service({ users: { create } });
    await svc.createProjectUser('r1', { email: 'ada@example.com' }, false, {
      user_metadata: { full_name: 'Ada' },
      phone: '+905551112233',
    });
    const rep = create.mock.calls[0][0];
    expect(rep.credentials).toEqual([]);
    expect(rep.emailVerified).toBe(false);
    expect(JSON.parse(rep.attributes.app_metadata[0])).toEqual(DEFAULT_APP_METADATA);
    expect(JSON.parse(rep.attributes.user_metadata[0])).toEqual({ full_name: 'Ada' });
    expect(rep.attributes.phoneNumber).toEqual(['+905551112233']);
    expect((svc as any).ensureUnmanagedAttributes).toHaveBeenCalledWith('r1');
  });

  it('setRealmUserMetadata merges into what is stored, drops null keys, and keeps other attributes', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const svc = service({
      users: {
        findOne: jest.fn().mockResolvedValue({
          id: 'u1',
          attributes: {
            phoneNumber: ['+90'],
            app_metadata: ['{"provider":"email","providers":["email"],"organization_id":"org-1"}'],
            user_metadata: ['{"full_name":"Ada","theme":"dark"}'],
          },
        }),
        update,
      },
    });
    const result = await svc.setRealmUserMetadata('r1', 'u1', {
      app_metadata: { plan: 'pro' },
      user_metadata: { theme: null, locale: 'tr' },
    });
    expect(result.app_metadata).toEqual({ provider: 'email', providers: ['email'], organization_id: 'org-1', plan: 'pro' });
    expect(result.user_metadata).toEqual({ full_name: 'Ada', locale: 'tr' });
    const written = update.mock.calls[0][1].attributes;
    expect(written.phoneNumber).toEqual(['+90']);
    expect(JSON.parse(written.app_metadata[0])).toEqual(result.app_metadata);
    expect(JSON.parse(written.user_metadata[0])).toEqual(result.user_metadata);
  });

  it('replace mode writes the documents as given', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const svc = service({
      users: { findOne: jest.fn().mockResolvedValue({ id: 'u1', attributes: { user_metadata: ['{"a":1}'] } }), update },
    });
    const result = await svc.setRealmUserMetadata('r1', 'u1', { user_metadata: { b: 2 } }, 'replace');
    expect(result.user_metadata).toEqual({ b: 2 });
  });

  it('readJsonAttribute tolerates a missing or broken attribute', () => {
    expect(KeycloakAdminService.readJsonAttribute({ attributes: {} }, 'app_metadata')).toEqual({});
    expect(KeycloakAdminService.readJsonAttribute({ attributes: { app_metadata: ['not json'] } }, 'app_metadata')).toEqual({});
    expect(KeycloakAdminService.readJsonAttribute({ attributes: { app_metadata: ['[1]'] } }, 'app_metadata')).toEqual({});
  });

  it('importRealmUsers enables custom attributes when a user carries metadata', async () => {
    const partialImport = jest.fn().mockResolvedValue({ results: [{ resourceType: 'USER', action: 'ADDED', resourceName: 'ada', id: 'u1' }] });
    const svc = service({ realms: { partialImport } });
    await svc.importRealmUsers('r1', [
      {
        id: 'u1', username: 'ada', email: 'ada@example.com', firstName: 'a', lastName: 'b', enabled: true, emailVerified: true,
        attributes: { app_metadata: ['{}'], user_metadata: ['{}'] },
      },
    ]);
    expect((svc as any).ensureUnmanagedAttributes).toHaveBeenCalledWith('r1');
    expect(partialImport.mock.calls[0][0].rep.users[0].attributes).toEqual({ app_metadata: ['{}'], user_metadata: ['{}'] });
  });
});

describe('setRealmAccessTokenLifespan', () => {
  it('writes the realm setting, clamped to a sane range', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const svc = service({ realms: { update } });
    await svc.setRealmAccessTokenLifespan('r1', 3600);
    expect(update).toHaveBeenCalledWith({ realm: 'r1' }, { accessTokenLifespan: 3600 });
    await svc.setRealmAccessTokenLifespan('r1', 5);
    expect(update).toHaveBeenLastCalledWith({ realm: 'r1' }, { accessTokenLifespan: 60 });
  });
});

describe('mintSessionForUser', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
  });

  it('impersonates, runs a prompt=none authorization with the cookies, and exchanges the code', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'set-cookie': ['KEYCLOAK_IDENTITY=idtok; Path=/realms/r1/; HttpOnly', 'KEYCLOAK_SESSION=sess; Path=/realms/r1/'] },
        data: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'at', refresh_token: 'rt', expires_in: 1800, token_type: 'Bearer' },
      });
    mockedAxios.get.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://api/rest/v1/auth/callback/p1/_mint?code=abc&session_state=x' },
      data: '',
    });
    const svc = service({});
    const tokens = await svc.mintSessionForUser('r1', 'u1', 'r1-anon', 'http://api/rest/v1/auth/callback/p1/_mint');
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 1800, tokenType: 'Bearer' });

    expect(mockedAxios.post.mock.calls[0][0]).toBe('http://kc:8080/admin/realms/r1/users/u1/impersonation');
    const authCall = mockedAxios.get.mock.calls[0];
    expect(authCall[0]).toMatch(/^http:\/\/kc:8080\/realms\/r1\/protocol\/openid-connect\/auth\?/);
    expect(authCall[0]).toContain('client_id=r1-anon');
    expect(authCall[0]).toContain('prompt=none');
    expect(authCall[1]).toMatchObject({ headers: { Cookie: 'KEYCLOAK_IDENTITY=idtok; KEYCLOAK_SESSION=sess' }, maxRedirects: 0 });
    const exchange = new URLSearchParams(mockedAxios.post.mock.calls[1][1] as string);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('abc');
    expect(exchange.get('client_id')).toBe('r1-anon');
  });

  it('says what to do when impersonation is refused', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 403, headers: {}, data: { errorMessage: 'HTTP 403 Forbidden' } });
    const svc = service({});
    await expect(svc.mintSessionForUser('r1', 'u1', 'r1-anon', 'http://api/cb')).rejects.toThrow(ServiceUnavailableException);
    await expect(svc.mintSessionForUser('r1', 'u1', 'r1-anon', 'http://api/cb')).rejects.toThrow(/impersonation is unavailable.*auth\/repair/);
  });

  it('reports the authorization error when prompt=none yields no code', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, headers: { 'set-cookie': ['KEYCLOAK_IDENTITY=x'] }, data: {} });
    mockedAxios.get.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://api/cb?error=login_required&error_description=Login+required' },
      data: '',
    });
    const svc = service({});
    await expect(svc.mintSessionForUser('r1', 'u1', 'r1-anon', 'http://api/cb')).rejects.toThrow(/Login required/);
  });
});
