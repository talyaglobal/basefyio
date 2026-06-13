import { apiClient, handleApiError } from '../lib/api.js';
import { isLoggedIn } from '../lib/config.js';
import { error } from '../lib/ui.js';

function requireLogin(): void {
  if (!isLoggedIn()) {
    error('You must be logged in. Run: basefyio login');
    process.exit(1);
  }
}

export async function listItems(
  projectId: string,
  structureId: string,
  opts: { limit?: string; cursor?: string },
): Promise<void> {
  requireLogin();
  try {
    const result = await apiClient.listItems(projectId, structureId, {
      limit: opts.limit ? parseInt(opts.limit, 10) : 20,
      cursor: opts.cursor,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function getItem(
  projectId: string,
  structureId: string,
  id: string,
): Promise<void> {
  requireLogin();
  try {
    const result = await apiClient.getItem(projectId, structureId, id);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function createItem(
  projectId: string,
  structureId: string,
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
    const result = await apiClient.createItem(projectId, structureId, parsed);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function updateItem(
  projectId: string,
  structureId: string,
  id: string,
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
    const result = await apiClient.updateItem(projectId, structureId, id, parsed);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function deleteItem(
  projectId: string,
  structureId: string,
  id: string,
): Promise<void> {
  requireLogin();
  try {
    const result = await apiClient.deleteItem(projectId, structureId, id);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    await handleApiError(err);
  }
}
