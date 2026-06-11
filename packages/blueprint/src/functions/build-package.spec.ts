import { describe, it, expect } from 'vitest';
import { buildPackage } from './build-package.js';
import { DataModel } from '../schemas/data-model.schema.js';
import { ApplicationModel } from '../schemas/application-model.schema.js';
import { UIModel } from '../schemas/ui-model.schema.js';

const makeDataModel = (): DataModel => ({
  tables: [
    {
      name: 'contacts',
      displayName: 'Contacts',
      fields: [
        { name: 'id', type: 'uuid', nullable: false, unique: true, primaryKey: true },
        { name: 'name', type: 'string', nullable: false, unique: false, primaryKey: false },
      ],
    },
  ],
  version: 1,
});

const makeApplicationModel = (): ApplicationModel => ({
  name: 'CRM App',
  roles: [
    { name: 'admin', permissions: { contacts: ['read', 'write', 'delete'] } },
  ],
  navigation: [{ label: 'Contacts', table: 'contacts' }],
  features: [],
  aiGenerated: false,
});

const makeUIModel = (): UIModel => ({
  pages: [
    { type: 'list', table: 'contacts', label: 'Contacts', search: true },
  ],
  version: 1,
});

describe('buildPackage', () => {
  it('always sets packageVersion to 1', () => {
    const pkg = buildPackage(
      { id: 'bp-1', projectId: 'proj-1', dataModel: makeDataModel(), applicationModel: makeApplicationModel(), uiModel: makeUIModel() },
      { id: 'ver-1', version: 1 },
    );

    expect(pkg.packageVersion).toBe(1);
  });

  it('carries blueprintId and applicationVersionId correctly', () => {
    const pkg = buildPackage(
      { id: 'bp-abc', projectId: 'proj-x', dataModel: makeDataModel(), applicationModel: makeApplicationModel(), uiModel: makeUIModel() },
      { id: 'ver-xyz', version: 2 },
    );

    expect(pkg.blueprintId).toBe('bp-abc');
    expect(pkg.applicationVersionId).toBe('ver-xyz');
  });

  it('includes the uiModel in the output', () => {
    const uiModel = makeUIModel();
    const pkg = buildPackage(
      { id: 'bp-1', projectId: null, dataModel: makeDataModel(), applicationModel: makeApplicationModel(), uiModel },
      { id: 'ver-1', version: 1 },
    );

    expect(pkg.uiModel).toEqual(uiModel);
  });

  it('sets tenantId equal to projectId', () => {
    const pkg = buildPackage(
      { id: 'bp-1', projectId: 'proj-99', dataModel: makeDataModel(), applicationModel: makeApplicationModel(), uiModel: makeUIModel() },
      { id: 'ver-1', version: 1 },
    );

    expect(pkg.tenantId).toBe(pkg.projectId);
  });

  it('handles null projectId', () => {
    const pkg = buildPackage(
      { id: 'bp-1', projectId: null, dataModel: makeDataModel(), applicationModel: makeApplicationModel(), uiModel: makeUIModel() },
      { id: 'ver-1', version: 1 },
    );

    expect(pkg.projectId).toBeNull();
    expect(pkg.tenantId).toBeNull();
  });

  it('uses aiProvenance from blueprint snapshot', () => {
    const provenance = { model: 'gpt-4o', confidence: 0.9 };
    const pkg = buildPackage(
      { id: 'bp-1', projectId: null, dataModel: makeDataModel(), applicationModel: makeApplicationModel(), uiModel: makeUIModel(), aiProvenance: provenance },
      { id: 'ver-1', version: 1 },
    );

    expect(pkg.aiProvenance).toEqual(provenance);
  });

  it('generates generatedAppIntent from blueprintId', () => {
    const pkg = buildPackage(
      { id: 'my-blueprint', projectId: null, dataModel: makeDataModel(), applicationModel: makeApplicationModel(), uiModel: makeUIModel() },
      { id: 'ver-1', version: 1 },
    );

    expect(pkg.generatedAppIntent).toContain('my-blueprint');
  });

  it('copies navigation from applicationModel into navigationModel', () => {
    const pkg = buildPackage(
      { id: 'bp-1', projectId: null, dataModel: makeDataModel(), applicationModel: makeApplicationModel(), uiModel: makeUIModel() },
      { id: 'ver-1', version: 1 },
    );

    expect(pkg.navigationModel).toEqual(makeApplicationModel().navigation);
  });
});
