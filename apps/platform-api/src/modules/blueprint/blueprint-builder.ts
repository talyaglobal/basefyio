import {
  detectValueFormat,
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

/** Added automatically to every generated table (see createRelationalTable). */
export const RESERVED_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

/** Build the inferred DataModel from raw sheets (reuses data-import inference). */
export function buildDataModel(input: AnalyzeBlueprintInput): DataModel {
  const exclude = new Set((input.excludeSheets ?? []).map((s) => s.toLowerCase()));
  const tables: DataModelTable[] = [];
  const warnings: string[] = [];
  for (const sheet of input.sheets ?? []) {
    if (!sheet?.name || exclude.has(sheet.name.toLowerCase())) continue;
    const rows = sheet.rows ?? [];
    // Read "12,50" and "01.02.2026" the way the file writes them (Turkish/European files).
    const columns = inferSchema(sheet.headers ?? [], rows, detectValueFormat(rows));
    if (columns.length === 0) continue;
    // A source column that collides with a system column is kept under a new name
    // instead of being dropped, so the user's own values are not lost.
    const taken = new Set(columns.map((c) => c.name));
    const tableName = sanitizeColumnName(sheet.name, 0);
    for (const c of columns) {
      if (!RESERVED_COLUMNS.has(c.name)) continue;
      let renamed = `source_${c.name}`;
      for (let i = 2; taken.has(renamed); i++) renamed = `source_${c.name}_${i}`;
      warnings.push(
        `${tableName}: column "${c.originalName}" is a system column (${c.name}) and was renamed to ${renamed}`,
      );
      taken.add(renamed);
      c.name = renamed;
    }
    tables.push({ name: tableName, label: sheet.name, columns });
  }
  return warnings.length ? { tables, warnings } : { tables };
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
