// The controller reaches an ESM-only Keycloak client through its imports, which Jest cannot load.
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProjectAuthController } from './project-auth.controller';

const ID = '3f2c9e1a-7b4d-4c58-9a21-0e6d5f8b7c11';

function build(opts: { existing?: boolean } = {}) {
  const keycloak = {
    findUserInRealm: jest.fn(async () => (opts.existing ? { id: 'x' } : null)),
    createUser: jest.fn(async (_realm: string, data: any) => ({ message: 'User created in realm', id: data.id ?? 'generated' })),
  };
  const projects = { findOne: jest.fn(async () => ({ keycloakRealm: 'realm-p1' })) };
  const activity = { append: jest.fn(async () => undefined) };
  const authConfig = { getOrCreate: jest.fn(async () => ({ minPasswordLength: 6 })) };
  const controller = new ProjectAuthController(projects as any, keycloak as any, authConfig as any, {} as any, activity as any, {} as any);
  return { controller, keycloak, activity };
}

describe('ProjectAuthController.createUser — keeping an id', () => {
  const user = { sub: 'u1' } as any;

  it('passes a given id through, so a user moved from another project keeps it', async () => {
    const { controller, keycloak } = build();
    const out = await controller.createUser('p1', { email: ' A@B.com ', password: 'secret-pw', id: ID }, user);
    expect(keycloak.createUser).toHaveBeenCalledWith('realm-p1', expect.objectContaining({ id: ID, email: 'A@B.com' }));
    expect(out).toMatchObject({ id: ID });
  });

  it('still creates a user with a generated id when none is given', async () => {
    const { controller, keycloak } = build();
    const out = await controller.createUser('p1', { email: 'a@b.com', password: 'secret-pw' }, user);
    expect(keycloak.createUser.mock.calls[0][1].id).toBeUndefined();
    expect(out).toMatchObject({ id: 'generated' });
  });

  it.each([['not-a-uuid'], [''], [123], [{}]])('refuses id=%p before touching Keycloak', async (bad) => {
    const { controller, keycloak } = build();
    await expect(controller.createUser('p1', { email: 'a@b.com', password: 'secret-pw', id: bad as any }, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(keycloak.createUser).not.toHaveBeenCalled();
  });

  it('still refuses a second account for the same email', async () => {
    const { controller, keycloak } = build({ existing: true });
    await expect(controller.createUser('p1', { email: 'a@b.com', password: 'secret-pw', id: ID }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(keycloak.createUser).not.toHaveBeenCalled();
  });
});

describe('ProjectAuthController.createUser — what the form accepts (#18)', () => {
  const user = { sub: 'u1' } as any;

  it('refuses an address without a domain suffix, a short password and a long name, before Keycloak', async () => {
    const { controller, keycloak } = build();
    await expect(controller.createUser('p1', { email: 'qa_e2e_bad@example', password: 'secret-pw' }, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.createUser('p1', { email: 'a@b.com', password: '12345' }, user)).rejects.toThrow(/at least 6/);
    await expect(controller.createUser('p1', { email: 'a@b.com', password: 'secret-pw', firstName: 'x'.repeat(101) }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(keycloak.createUser).not.toHaveBeenCalled();
  });

  it('uses the project\'s own minimum length', async () => {
    const { controller } = build();
    (controller as any).authConfigService.getOrCreate = jest.fn(async () => ({ minPasswordLength: 10 }));
    await expect(controller.createUser('p1', { email: 'a@b.com', password: 'only-nine!' }, user)).resolves.toBeDefined();
    await expect(controller.createUser('p1', { email: 'a@b.com', password: 'too-short' }, user)).rejects.toThrow(/at least 10/);
  });
});

describe('ProjectAuthController.updateUser — phone and e-mail (#18)', () => {
  const user = { sub: 'u1' } as any;

  function buildUpdate() {
    const keycloak = { updateRealmUser: jest.fn(async () => undefined) };
    const projects = { findOne: jest.fn(async () => ({ keycloakRealm: 'realm-p1' })) };
    const activity = { append: jest.fn(async () => undefined) };
    const controller = new ProjectAuthController(projects as any, keycloak as any, {} as any, {} as any, activity as any, {} as any);
    return { controller, keycloak };
  }

  it('stores a phone number in E.164, clears an empty one, refuses text', async () => {
    const { controller, keycloak } = buildUpdate();
    await controller.updateUser('p1', 'u9', { phoneNumber: '+90 555 123 45 67' }, user);
    expect(keycloak.updateRealmUser).toHaveBeenLastCalledWith('realm-p1', 'u9', { phoneNumber: '+905551234567' });
    await controller.updateUser('p1', 'u9', { phoneNumber: '' }, user);
    expect(keycloak.updateRealmUser).toHaveBeenLastCalledWith('realm-p1', 'u9', { phoneNumber: '' });
    await expect(controller.updateUser('p1', 'u9', { phoneNumber: 'abc-not-phone' }, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.updateUser('p1', 'u9', { email: 'bad@example' }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(keycloak.updateRealmUser).toHaveBeenCalledTimes(2);
  });
});

