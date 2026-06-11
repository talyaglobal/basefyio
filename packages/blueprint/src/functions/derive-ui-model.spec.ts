import { describe, it, expect } from 'vitest';
import { deriveUIModel } from './derive-ui-model.js';
import { BuildPackage } from '../schemas/build-package.schema.js';
import { DataModel } from '../schemas/data-model.schema.js';
import { ApplicationModel } from '../schemas/application-model.schema.js';
import { UIModel } from '../schemas/ui-model.schema.js';

const makeDataModel = (tableCount = 2): DataModel => ({
  tables: Array.from({ length: tableCount }, (_, i) => ({
    name: `table_${i}`,
    displayName: `Table ${i}`,
    fields: [
      { name: 'id', type: 'uuid' as const, nullable: false, unique: true, primaryKey: true },
    ],
  })),
  version: 1,
});

const makeApplicationModel = (): ApplicationModel => ({
  name: 'Test App',
  roles: [],
  navigation: [
    { label: 'Table 0', table: 'table_0' },
    { label: 'Table 1', table: 'table_1' },
  ],
  features: [],
  aiGenerated: false,
});

const makeUIModel = (): UIModel => ({
  pages: [],
  version: 1,
});

const makePkg = (tableCount = 2): BuildPackage => ({
  packageVersion: 1,
  projectId: null,
  tenantId: null,
  blueprintId: 'bp-test',
  applicationVersionId: 'ver-test',
  dataModel: makeDataModel(tableCount),
  permissionsModel: {},
  applicationModel: makeApplicationModel(),
  navigationModel: makeApplicationModel().navigation,
  formDefinitions: {},
  tableListViews: {},
  dashboardReportDefinitions: {},
  apiDefinitions: {},
  authRequirements: {},
  sampleRecords: {},
  aiProvenance: {},
  designHints: {},
  uiModel: makeUIModel(),
  generatedAppIntent: '',
});

describe('deriveUIModel', () => {
  it('always places the dashboard page first', () => {
    const uiModel = deriveUIModel(makePkg(2));

    expect(uiModel.pages[0].type).toBe('dashboard');
  });

  it('generates list, form, and detail pages for each table', () => {
    const uiModel = deriveUIModel(makePkg(2));
    const types = uiModel.pages.map((p) => p.type);

    expect(types).toContain('list');
    expect(types).toContain('form');
    expect(types).toContain('detail');
  });

  it('page count equals tableCount * 3 + 1 (dashboard)', () => {
    const tableCount = 3;
    const uiModel = deriveUIModel(makePkg(tableCount));

    expect(uiModel.pages).toHaveLength(tableCount * 3 + 1);
  });

  it('list pages have search=true', () => {
    const uiModel = deriveUIModel(makePkg(1));
    const listPages = uiModel.pages.filter((p) => p.type === 'list');

    listPages.forEach((p) => expect(p.search).toBe(true));
  });

  it('each table gets exactly one list, one form, and one detail page', () => {
    const tableCount = 2;
    const uiModel = deriveUIModel(makePkg(tableCount));

    for (let i = 0; i < tableCount; i++) {
      const tableName = `table_${i}`;
      const forTable = uiModel.pages.filter((p) => p.table === tableName);

      expect(forTable.filter((p) => p.type === 'list')).toHaveLength(1);
      expect(forTable.filter((p) => p.type === 'form')).toHaveLength(1);
      expect(forTable.filter((p) => p.type === 'detail')).toHaveLength(1);
    }
  });

  it('dashboard widgets reference up to 4 navigation entries', () => {
    const uiModel = deriveUIModel(makePkg(2));
    const dashboard = uiModel.pages[0];

    expect(dashboard.widgets).toBeDefined();
    expect(dashboard.widgets!.length).toBeLessThanOrEqual(4);
    expect(dashboard.widgets![0]).toMatch(/^count:/);
  });

  it('works with zero tables — only dashboard page', () => {
    const uiModel = deriveUIModel(makePkg(0));

    expect(uiModel.pages).toHaveLength(1);
    expect(uiModel.pages[0].type).toBe('dashboard');
  });
});
