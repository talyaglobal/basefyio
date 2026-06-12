import { apiClient, handleApiError } from '../lib/api.js';
import { isLoggedIn } from '../lib/config.js';
import { error } from '../lib/ui.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function requireLogin(): void {
  if (!isLoggedIn()) {
    error('You must be logged in. Run: basefyio login');
    process.exit(1);
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

export async function listItems(
  projectId: string,
  entityName: string,
  opts: { limit?: string; cursor?: string; sort?: string; order?: string; filter?: string[] },
): Promise<void> {
  requireLogin();
  try {
    const filters: Record<string, string> = {};
    if (opts.filter) {
      for (const f of opts.filter) {
        const eqIndex = f.indexOf('=');
        if (eqIndex !== -1) {
          const k = f.slice(0, eqIndex);
          const v = f.slice(eqIndex + 1);
          filters[k] = v;
        }
      }
    }
    const result = await apiClient.listItems(projectId, entityName, {
      limit: opts.limit ? parseInt(opts.limit, 10) : 20,
      cursor: opts.cursor,
      sort: opts.sort,
      order: opts.order,
      filters,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function getItem(
  projectId: string,
  entityName: string,
  id: string,
): Promise<void> {
  requireLogin();
  try {
    const result = await apiClient.getItem(projectId, entityName, id);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function createItem(
  projectId: string,
  entityName: string,
  data: string,
): Promise<void> {
  requireLogin();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error('--data must be a valid JSON string');
  }
  try {
    const result = await apiClient.createItem(projectId, entityName, parsed);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function deleteItem(
  projectId: string,
  entityName: string,
  id: string,
): Promise<void> {
  requireLogin();
  try {
    const result = await apiClient.deleteItem(projectId, entityName, id);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}
