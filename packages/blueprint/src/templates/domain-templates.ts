import type { ApplicationModel } from '../schemas/application-model.schema.js';

interface DomainTemplateDefaults {
  slug: string;
  displayName: string;
  navigation: ApplicationModel['navigation'];
  roles: ApplicationModel['roles'];
  features: string[];
  promptKeywords: string[];  // used by detectDomain() heuristic
}

const ALL_TABLES_READ: ('read' | 'write' | 'delete')[] = ['read'];
const ALL_TABLES_WRITE: ('read' | 'write' | 'delete')[] = ['read', 'write'];
const ALL_TABLES_ADMIN: ('read' | 'write' | 'delete')[] = ['read', 'write', 'delete'];

export const CRM_TEMPLATE: DomainTemplateDefaults = {
  slug: 'crm',
  displayName: 'CRM',
  promptKeywords: ['customers', 'contacts', 'leads', 'deals', 'activities', 'pipeline', 'sales'],
  navigation: [
    { label: 'Dashboard', table: 'dashboard', icon: 'chart-bar' },
    { label: 'Customers', table: 'customers', icon: 'users' },
    { label: 'Leads', table: 'leads', icon: 'user-plus' },
    { label: 'Deals', table: 'deals', icon: 'currency-dollar' },
    { label: 'Activities', table: 'activities', icon: 'calendar' },
  ],
  roles: [
    { name: 'admin', permissions: { customers: ALL_TABLES_ADMIN, leads: ALL_TABLES_ADMIN, deals: ALL_TABLES_ADMIN, activities: ALL_TABLES_ADMIN } },
    { name: 'sales', permissions: { customers: ALL_TABLES_WRITE, leads: ALL_TABLES_WRITE, deals: ALL_TABLES_WRITE, activities: ALL_TABLES_WRITE } },
    { name: 'viewer', permissions: { customers: ALL_TABLES_READ, leads: ALL_TABLES_READ, deals: ALL_TABLES_READ, activities: ALL_TABLES_READ } },
  ],
  features: ['timeline-detail', 'kanban-deals', 'activity-feed'],
};

export const INVENTORY_TEMPLATE: DomainTemplateDefaults = {
  slug: 'inventory',
  displayName: 'Inventory',
  promptKeywords: ['products', 'inventory', 'stock', 'warehouse', 'items', 'sku', 'supplier'],
  navigation: [
    { label: 'Dashboard', table: 'dashboard', icon: 'chart-bar' },
    { label: 'Products', table: 'products', icon: 'cube' },
    { label: 'Inventory', table: 'inventory', icon: 'archive' },
    { label: 'Suppliers', table: 'suppliers', icon: 'truck' },
  ],
  roles: [
    { name: 'admin', permissions: { products: ALL_TABLES_ADMIN, inventory: ALL_TABLES_ADMIN, suppliers: ALL_TABLES_ADMIN } },
    { name: 'warehouse', permissions: { products: ALL_TABLES_WRITE, inventory: ALL_TABLES_WRITE, suppliers: ALL_TABLES_READ } },
    { name: 'viewer', permissions: { products: ALL_TABLES_READ, inventory: ALL_TABLES_READ, suppliers: ALL_TABLES_READ } },
  ],
  features: ['stock-level-chart', 'reorder-alerts', 'warehouse-dashboard'],
};

export const ORDERS_TEMPLATE: DomainTemplateDefaults = {
  slug: 'orders',
  displayName: 'Orders',
  promptKeywords: ['orders', 'order_items', 'shipments', 'invoices', 'customers', 'products'],
  navigation: [
    { label: 'Dashboard', table: 'dashboard', icon: 'chart-bar' },
    { label: 'Orders', table: 'orders', icon: 'shopping-cart' },
    { label: 'Customers', table: 'customers', icon: 'users' },
    { label: 'Products', table: 'products', icon: 'cube' },
    { label: 'Shipments', table: 'shipments', icon: 'truck' },
  ],
  roles: [
    { name: 'admin', permissions: { orders: ALL_TABLES_ADMIN, customers: ALL_TABLES_ADMIN, products: ALL_TABLES_ADMIN, shipments: ALL_TABLES_ADMIN } },
    { name: 'fulfillment', permissions: { orders: ALL_TABLES_WRITE, shipments: ALL_TABLES_WRITE, products: ALL_TABLES_READ, customers: ALL_TABLES_READ } },
    { name: 'viewer', permissions: { orders: ALL_TABLES_READ, customers: ALL_TABLES_READ, products: ALL_TABLES_READ, shipments: ALL_TABLES_READ } },
  ],
  features: ['kanban-by-status', 'revenue-chart'],
};

export const GENERIC_TEMPLATE: DomainTemplateDefaults = {
  slug: 'generic',
  displayName: 'Generic',
  promptKeywords: [],
  navigation: [],   // will be derived from tables at runtime
  roles: [
    { name: 'admin', permissions: {} },
    { name: 'user', permissions: {} },
  ],
  features: [],
};

export const P0_TEMPLATES: Record<string, DomainTemplateDefaults> = {
  crm: CRM_TEMPLATE,
  inventory: INVENTORY_TEMPLATE,
  orders: ORDERS_TEMPLATE,
  generic: GENERIC_TEMPLATE,
};

/**
 * Detect domain from table names using keyword matching.
 * Returns the first template whose promptKeywords appear in any table name.
 * Falls back to 'generic'.
 */
export function detectDomainFromTables(tableNames: string[]): string {
  const lowerTables = tableNames.map((t) => t.toLowerCase());
  for (const [slug, template] of Object.entries(P0_TEMPLATES)) {
    if (slug === 'generic') continue;
    if (template.promptKeywords.some((kw) => lowerTables.some((t) => t.includes(kw)))) {
      return slug;
    }
  }
  return 'generic';
}

export type { DomainTemplateDefaults };
