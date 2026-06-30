import {
  inferSchema,
  sanitizeColumnName,
} from '../data-import/lib/type-inferrer';
import {
  AnalyzeBlueprintInput,
  ApplicationModel,
  AppRole,
  BlueprintDomain,
  BusinessModel,
  DataModel,
  DataModelTable,
} from './blueprint.types';

/** Keyword → domain heuristics applied to sheet/table names. */
const DOMAIN_KEYWORDS: Record<Exclude<BlueprintDomain, 'generic'>, string[]> = {
  crm: ['customer', 'lead', 'contact', 'account', 'opportunity', 'deal'],
  inventory: ['product', 'stock', 'inventory', 'item', 'warehouse', 'sku'],
  orders: ['order', 'invoice', 'sale', 'payment', 'transaction', 'cart'],
  hr: ['employee', 'staff', 'payroll', 'department', 'leave', 'attendance'],
};

const DOMAIN_KPIS: Record<BlueprintDomain, string[]> = {
  crm: ['Total customers', 'New leads', 'Open opportunities'],
  inventory: ['Total products', 'Low-stock items', 'Inventory value'],
  orders: ['Total orders', 'Revenue', 'Pending orders'],
  hr: ['Headcount', 'Open positions', 'Pending leave requests'],
  generic: ['Total records', 'Recently added'],
};

/** Build the inferred DataModel from raw sheets (reuses data-import inference). */
export function buildDataModel(input: AnalyzeBlueprintInput): DataModel {
  const exclude = new Set((input.excludeSheets ?? []).map((s) => s.toLowerCase()));
  // These are added automatically to every generated table, so drop any inferred
  // columns that would collide with them.
  const RESERVED = new Set(['id', 'created_at', 'updated_at']);
  const tables: DataModelTable[] = [];
  for (const sheet of input.sheets ?? []) {
    if (!sheet?.name || exclude.has(sheet.name.toLowerCase())) continue;
    const columns = inferSchema(sheet.headers ?? [], sheet.rows ?? []).filter(
      (c) => !RESERVED.has(c.name.toLowerCase()),
    );
    if (columns.length === 0) continue;
    tables.push({
      name: sanitizeColumnName(sheet.name, 0),
      label: sheet.name,
      columns,
    });
  }
  return { tables };
}

export function detectDomain(dataModel: DataModel): BlueprintDomain {
  const haystack = dataModel.tables
    .flatMap((t) => [t.name, t.label, ...t.columns.map((c) => c.originalName)])
    .join(' ')
    .toLowerCase();
  let best: BlueprintDomain = 'generic';
  let bestScore = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.reduce((n, k) => (haystack.includes(k) ? n + 1 : n), 0);
    if (score > bestScore) {
      bestScore = score;
      best = domain as BlueprintDomain;
    }
  }
  return best;
}

export function buildBusinessModel(dataModel: DataModel, domain: BlueprintDomain): BusinessModel {
  return {
    domain,
    actors: ['Admin', 'Member'],
    objects: dataModel.tables.map((t) => t.label),
    kpis: DOMAIN_KPIS[domain],
  };
}

export function buildApplicationModel(
  dataModel: DataModel,
  domain: BlueprintDomain,
  appName?: string,
): ApplicationModel {
  const tables = dataModel.tables.map((t) => t.name);
  const adminPerms: AppRole['permissions'] = {};
  const memberPerms: AppRole['permissions'] = {};
  for (const t of tables) {
    adminPerms[t] = ['read', 'create', 'update', 'delete'];
    memberPerms[t] = ['read'];
  }
  return {
    name: appName?.trim() || `${domain[0].toUpperCase()}${domain.slice(1)} App`,
    roles: [
      { name: 'Admin', permissions: adminPerms },
      { name: 'Member', permissions: memberPerms },
    ],
    navigation: dataModel.tables.map((t) => ({ label: t.label, table: t.name })),
    tables,
  };
}
