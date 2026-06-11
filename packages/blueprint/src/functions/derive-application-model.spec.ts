import { describe, it, expect } from 'vitest';
import { deriveApplicationModel } from './derive-application-model.js';
import { BusinessModel } from '../schemas/business-model.schema.js';

const makeBusinessModel = (overrides: Partial<BusinessModel> = {}): BusinessModel => ({
  actors: [],
  objects: [
    { name: 'Contacts', table: 'contacts' },
    { name: 'Deals', table: 'deals' },
  ],
  processes: [],
  metrics: [],
  domain: 'crm',
  ...overrides,
});

describe('deriveApplicationModel', () => {
  it('generates default navigation from business objects', () => {
    const bm = makeBusinessModel();
    const app = deriveApplicationModel(bm);

    expect(app.navigation).toHaveLength(2);
    expect(app.navigation[0]).toMatchObject({ label: 'Contacts', table: 'contacts' });
    expect(app.navigation[1]).toMatchObject({ label: 'Deals', table: 'deals' });
  });

  it('uses template navigation overrides when provided', () => {
    const bm = makeBusinessModel();
    const customNav = [{ label: 'My Contacts', table: 'contacts', icon: 'user' }];
    const app = deriveApplicationModel(bm, { navigation: customNav });

    expect(app.navigation).toHaveLength(1);
    expect(app.navigation[0]).toMatchObject({ label: 'My Contacts', icon: 'user' });
  });

  it('sets aiGenerated flag correctly', () => {
    const bm = makeBusinessModel();

    const appFalse = deriveApplicationModel(bm, {}, { aiGenerated: false });
    expect(appFalse.aiGenerated).toBe(false);

    const appTrue = deriveApplicationModel(bm, {}, { aiGenerated: true });
    expect(appTrue.aiGenerated).toBe(true);
  });

  it('is deterministic — same input yields identical output', () => {
    const bm = makeBusinessModel();
    const result1 = deriveApplicationModel(bm);
    const result2 = deriveApplicationModel(bm);

    expect(result1).toEqual(result2);
  });

  it('derives app name from domain slug', () => {
    const bm = makeBusinessModel({ domain: 'inventory' });
    const app = deriveApplicationModel(bm);

    expect(app.name).toBe('Inventory App');
  });

  it('defaults to "App" when no domain is set', () => {
    const bm = makeBusinessModel({ domain: undefined });
    const app = deriveApplicationModel(bm);

    expect(app.name).toBe('App');
  });

  it('generates default admin + user roles', () => {
    const bm = makeBusinessModel();
    const app = deriveApplicationModel(bm);

    expect(app.roles).toHaveLength(2);
    expect(app.roles[0].name).toBe('admin');
    expect(app.roles[0].permissions['contacts']).toContain('delete');
    expect(app.roles[1].name).toBe('user');
    expect(app.roles[1].permissions['contacts']).toEqual(['read']);
  });

  it('uses template role overrides when provided', () => {
    const bm = makeBusinessModel();
    const customRoles = [{ name: 'superadmin', permissions: { contacts: ['read', 'write', 'delete'] as const } }];
    const app = deriveApplicationModel(bm, { roles: customRoles });

    expect(app.roles).toHaveLength(1);
    expect(app.roles[0].name).toBe('superadmin');
  });

  it('sets templateSlug when provided', () => {
    const bm = makeBusinessModel();
    const app = deriveApplicationModel(bm, {}, { templateSlug: 'crm-starter' });

    expect(app.templateSlug).toBe('crm-starter');
  });
});
