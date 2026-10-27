/**
 * Keycloak compatibility: the real KeycloakAdminService (from dist/) against
 * a real Keycloak server. CI runs it against every supported version
 * (deploy/components.env: KEYCLOAK_SUPPORTED) — 24 today and 26.
 *
 *   npm run build
 *   KEYCLOAK_URL=http://localhost:8080 KEYCLOAK_ADMIN_USER=admin KEYCLOAK_ADMIN_PASSWORD=admin \
 *     node --test test/keycloak-compat.test.mjs
 *
 * Node 22 or newer: the Keycloak admin client is an ES module the compiled
 * service requires.
 *
 * It creates one throwaway project realm and one platform user and removes
 * both at the end; nothing else on the server is changed except the master
 * realm settings the API itself applies at boot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KeycloakAdminService } = require('../dist/modules/auth/keycloak-admin.service.js');

const URL_BASE = (process.env.KEYCLOAK_URL || 'http://localhost:8080').replace(/\/+$/, '');
const values = {
  'keycloak.url': URL_BASE,
  'keycloak.publicUrl': URL_BASE,
  'keycloak.adminUser': process.env.KEYCLOAK_ADMIN_USER || 'admin',
  'keycloak.adminPassword': process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin',
  'keycloak.adminClientId': 'admin-cli',
  'keycloak.postLogoutRedirectUrisExtra': '',
  'keycloak.realmSmtp': true,
  appUrl: 'http://localhost:3000',
  publicApiUrl: 'http://localhost:4000',
  platformKeycloakClientId: 'basefyio-platform',
  'oauth.googleClientId': '',
  'oauth.githubClientId': '',
  'mail.transport': 'smtp',
  'mail.from': 'Compat <noreply@example.test>',
  'mail.smtp.host': 'smtp.example.test',
  'mail.smtp.port': 587,
  'mail.smtp.security': 'starttls',
  'resend.replyTo': 'support@example.test',
};
const config = { get: (k) => values[k] };
const kc = new KeycloakAdminService(config);

const RUN = Date.now().toString(36);
const REALM = `compat_${RUN}`;
const USER_EMAIL = `user-${RUN}@example.test`;
const PLATFORM_EMAIL = `platform-${RUN}@example.test`;

async function adminToken() {
  const res = await fetch(`${URL_BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: values['keycloak.adminUser'], password: values['keycloak.adminPassword'] }),
  });
  assert.equal(res.status, 200, 'admin token');
  return (await res.json()).access_token;
}

async function adminGet(path) {
  const res = await fetch(`${URL_BASE}/admin/realms${path}`, { headers: { Authorization: `Bearer ${await adminToken()}` } });
  assert.equal(res.status, 200, `GET ${path}`);
  return res.json();
}

async function passwordGrant(realm, clientId, username, password) {
  const res = await fetch(`${URL_BASE}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: clientId, username, password, scope: 'openid' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `password grant in ${realm}: ${JSON.stringify(body)}`);
  return body;
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

test('boot: the API signs in and prepares the master realm', async () => {
  await kc.onModuleInit();
  const master = await adminGet('/master');
  assert.ok(master.accessTokenLifespan >= 1800, 'access token lifespan raised');
  assert.equal(master.loginWithEmailAllowed, true);
  assert.ok(master.ssoSessionIdleTimeout >= 2592000, 'sessions last 30 days');
  assert.equal(master.smtpServer?.host, 'smtp.example.test', 'realm SMTP written at boot');
  const flows = await adminGet('/master/authentication/flows');
  assert.ok(flows.some((f) => f.alias === 'auto-link-broker'), 'auto-link flow exists');
  const clients = await adminGet('/master/clients?clientId=basefyio-platform');
  assert.equal(clients.length, 1, 'platform OAuth client exists');
  const [cli] = await adminGet('/master/clients?clientId=admin-cli');
  assert.notEqual(cli.attributes?.['client.use.lightweight.access.token.enabled'], 'true', 'admin-cli issues full access tokens');
  await kc.assertHealthy();
});

test('project realm: create, clients, users, tokens carry the claims the API reads', async () => {
  await kc.createRealm(REALM);
  assert.equal(await kc.realmExists(REALM), true);
  const realm = await adminGet(`/${REALM}`);
  assert.equal(realm.smtpServer?.host, 'smtp.example.test', 'new realms get the SMTP settings');
  assert.equal(realm.smtpServer?.from, 'noreply@example.test');

  const keys = await kc.createClients(REALM);
  assert.match(keys.anonKey, /^bf_anon_/);
  const anonClient = `${REALM}-anon`;
  await kc.ensureRealmClientDirectGrant(REALM, anonClient);
  await kc.ensureRealmClientAuthTimeMapper(REALM, anonClient);

  const userId = await kc.createProjectUser(REALM, { email: USER_EMAIL, password: 'Compat-pass-1!', firstName: 'Compat', lastName: 'User' }, true);
  assert.ok(userId);
  const found = await kc.findUserInRealm(REALM, USER_EMAIL);
  assert.equal(found?.id, userId);

  // Keycloak 25 moved `sub` into a new default client scope ("basic"); the
  // API verifies end-user tokens and reads sub and email from them.
  const tokens = await passwordGrant(REALM, anonClient, USER_EMAIL, 'Compat-pass-1!');
  const c = claims(tokens.access_token);
  assert.equal(c.sub, userId, 'access token carries sub');
  assert.equal(c.email, USER_EMAIL, 'access token carries email');
  assert.match(c.iss, new RegExp(`/realms/${REALM}$`));
  // The anon client carries the auth_time mapper. Keycloak writes the AUTH_TIME
  // session note only when a browser sign-in completes, so a password grant
  // gets no auth_time from it on any version — the same on 24 and 26.
  const [anon] = await adminGet(`/${REALM}/clients?clientId=${anonClient}`);
  const mappers = await adminGet(`/${REALM}/clients/${anon.id}/protocol-mappers/models`);
  assert.ok(mappers.some((m) => m.name === 'auth_time'), 'auth_time mapper on the anon client');

  await kc.resetRealmUserPassword(REALM, userId, 'Compat-pass-2!');
  await passwordGrant(REALM, anonClient, USER_EMAIL, 'Compat-pass-2!');
  await kc.setUserRequiredAction(REALM, userId, 'UPDATE_PASSWORD', true);
  await kc.setUserRequiredAction(REALM, userId, 'UPDATE_PASSWORD', false);
  await kc.updateRealmUser(REALM, userId, { firstName: 'Renamed', phoneNumber: '+905550000000' });
  const after = await kc.getRealmUserById(REALM, userId);
  assert.equal(after?.firstName, 'Renamed');

  const users = await kc.listUsers(REALM);
  assert.ok(Array.isArray(users) && users.length >= 1);
  const info = await kc.getRealmInfo(REALM);
  assert.ok(info.clientCount >= 2);
});

test('project realm: identity providers and anonymous users', async () => {
  await kc.upsertIdentityProvider(REALM, 'google', 'compat-client-id', 'compat-secret', `http://localhost:4000/api/rest/v1/auth/callback/google`);
  const idps = await kc.listIdentityProviders(REALM);
  assert.ok(JSON.stringify(idps).includes('google'), 'google provider listed');
  await kc.deleteIdentityProvider(REALM, 'google');

  const anonClient = `${REALM}-anon`;
  await kc.ensureRealmClientAnonymousClaimMapper(REALM, anonClient);
  const anonId = await kc.createAnonymousUser(REALM, `anon-${RUN}`, 'Anon-pass-1!');
  assert.ok(anonId);
});

test('project realm: deactivate, activate, delete', async () => {
  await kc.disableRealm(REALM);
  assert.equal((await adminGet(`/${REALM}`)).enabled, false);
  await kc.enableRealm(REALM);
  assert.equal((await adminGet(`/${REALM}`)).enabled, true);
  await kc.deleteRealm(REALM);
  assert.equal(await kc.realmExists(REALM), false);
});

test('platform users: create, sign in, reset, delete', async () => {
  const id = await kc.createPlatformUser({ email: PLATFORM_EMAIL, password: 'Platform-pass-1!', firstName: 'Platform', lastName: 'Compat' });
  assert.ok(id);
  const found = await kc.findPlatformUserByEmail(PLATFORM_EMAIL);
  assert.equal(found?.id, id);
  // Platform sign-in: a password grant on admin-cli, whose token must carry sub
  // and email (Keycloak 25+ makes admin-cli tokens lightweight; boot undoes it).
  const tokens = await passwordGrant('master', 'admin-cli', PLATFORM_EMAIL, 'Platform-pass-1!');
  assert.equal(claims(tokens.access_token).sub, id, 'master-realm token carries sub');
  assert.equal(claims(tokens.access_token).email, PLATFORM_EMAIL, 'master-realm token carries email');
  await kc.resetPlatformUserPassword(id, 'Platform-pass-2!', PLATFORM_EMAIL);
  await passwordGrant('master', 'admin-cli', PLATFORM_EMAIL, 'Platform-pass-2!');
  await kc.deletePlatformUser(id);
  assert.ok(!(await kc.findPlatformUserByEmail(PLATFORM_EMAIL)), 'platform user removed');
});
