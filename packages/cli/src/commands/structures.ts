import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig } from '../lib/config.js';
import { error, success, info, printTable } from '../lib/ui.js';

async function requireProjectId(): Promise<string> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }
  return config.projectId;
}

function colorBadge(badge: 'SQL' | 'JSON'): string {
  return badge === 'SQL' ? chalk.green(badge) : chalk.yellow(badge);
}

export async function listStructures(): Promise<void> {
  const projectId = await requireProjectId();
  try {
    const structures = await apiClient.listStructures(projectId);
    if (structures.length === 0) {
      info('No data structures yet — run: basefyio structures create');
      return;
    }
    printTable(
      ['name', 'badge', 'editorMode', 'id'],
      structures.map((s) => [s.name, colorBadge(s.badge), s.editorMode, s.id]),
    );
  } catch (err) {
    await handleApiError(err);
  }
}

export async function getStructure(structureId: string): Promise<void> {
  const projectId = await requireProjectId();
  try {
    const s = await apiClient.getStructure(projectId, structureId);
    printTable(
      ['field', 'value'],
      [
        ['id', s.id],
        ['name', s.name],
        ['kind', s.kind],
        ['badge', colorBadge(s.badge)],
        ['editorMode', s.editorMode],
        ['dataEditorMode', s.dataEditorMode],
        ['aiRecommended', String(s.aiRecommended)],
        ['createdAt', s.createdAt],
      ],
    );
  } catch (err) {
    await handleApiError(err);
  }
}

export async function createStructure(
  name: string,
  kind: 'relational' | 'json',
): Promise<void> {
  const projectId = await requireProjectId();
  try {
    const structure = await apiClient.createStructure(projectId, name, kind);
    success(`Structure "${name}" created ${colorBadge(structure.badge)} — editor: ${structure.editorMode}`);
  } catch (err) {
    await handleApiError(err);
  }
}

export async function deleteStructure(structureId: string): Promise<void> {
  const projectId = await requireProjectId();
  try {
    await apiClient.deleteStructure(projectId, structureId);
    success(`Structure ${structureId} deleted.`);
  } catch (err) {
    await handleApiError(err);
  }
}
