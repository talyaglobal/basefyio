import { unstable_cache } from 'next/cache';
import { BuildPackage } from './types';

const API_URL = process.env.PLATFORM_API_URL || 'http://localhost:3000';

export async function fetchBuildPackage(projectId: string): Promise<BuildPackage | null> {
  try {
    const res = await fetch(`${API_URL}/v1/blueprints/by-project/${projectId}/build-package`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export const loadBuildPackage = (projectId: string) =>
  unstable_cache(
    () =>
      fetchBuildPackage(projectId).then((bp) => bp ?? demoBuildPackage()),
    [`build-package-${projectId}`],
    { revalidate: 60, tags: [`build-package-${projectId}`] },
  )();

export async function fetchTableRows(
  projectId: string,
  tableName: string,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const API = process.env.PLATFORM_API_URL || 'http://localhost:3000';
  try {
    const res = await fetch(
      `${API}/v1/projects/${projectId}/data/${tableName}?limit=${limit}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function fetchTableRow(
  projectId: string,
  tableName: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const API = process.env.PLATFORM_API_URL || 'http://localhost:3000';
  try {
    const res = await fetch(
      `${API}/v1/projects/${projectId}/data/${tableName}/${id}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/** Returns a demo build package for development without a running API */
export function demoBuildPackage(): BuildPackage {
  return {
    version: 1,
    projectId: 'demo',
    generatedAt: new Date().toISOString(),
    dataModel: {
      tables: [
        {
          name: 'customers',
          displayName: 'Customers',
          fields: [
            { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
            { name: 'name', type: 'string', nullable: false },
            { name: 'email', type: 'string', nullable: true },
            { name: 'created_at', type: 'date', nullable: false },
          ],
        },
        {
          name: 'orders',
          displayName: 'Orders',
          fields: [
            { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
            { name: 'customer_id', type: 'uuid', nullable: true, foreignKey: 'customers' },
            { name: 'amount', type: 'number', nullable: false },
            { name: 'status', type: 'string', nullable: false },
            { name: 'created_at', type: 'date', nullable: false },
          ],
        },
      ],
    },
    applicationModel: {
      name: 'Demo App',
      navigation: [
        { label: 'Dashboard', table: 'dashboard', icon: 'chart-bar' },
        { label: 'Customers', table: 'customers', icon: 'users' },
        { label: 'Orders', table: 'orders', icon: 'shopping-cart' },
      ],
      roles: [{ name: 'admin', permissions: { customers: ['read', 'write', 'delete'], orders: ['read', 'write', 'delete'] } }],
    },
    uiModel: {
      pages: [
        { type: 'list', table: 'customers', label: 'Customers', search: true },
        { type: 'form', table: 'customers', label: 'New Customer' },
        { type: 'detail', table: 'customers', label: 'Customer Details' },
        { type: 'list', table: 'orders', label: 'Orders', search: true },
        { type: 'form', table: 'orders', label: 'New Order' },
        { type: 'detail', table: 'orders', label: 'Order Details' },
      ],
    },
  };
}
