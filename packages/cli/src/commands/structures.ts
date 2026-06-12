import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { getProjectConfig } from '../lib/config.js';
import { error, success, info, printTable } from '../lib/ui.js';

// ── commands ─────────────────────────────────────────────────────────────────

export async function listStructures(): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  try {
    const structures = await apiClient.listStructures(config.projectId);

    if (structures.length === 0) {
      info('No data structures yet — run: basefyio structures create');
      return;
    }

    const rows = structures.map((s) => {
      const badge =
        s.badge === 'SQL'
          ? chalk.green(s.badge)
          : chalk.yellow(s.badge);
      return [s.name, badge, s.editorMode, s.id];
    });

    printTable(['name', 'badge', 'editorMode', 'id'], rows);
  } catch (err) {
    await handleApiError(err);
  }
}

export async function createStructure(
  name: string,
  kind: 'relational' | 'json',
): Promise<void> {
  const config = await getProjectConfig();
  if (!config?.projectId) {
    error('No linked project. Run: basefyio link');
    process.exit(1);
  }

  try {
    const structure = await apiClient.createStructure(config.projectId, name, kind);
    const badge =
      structure.badge === 'SQL'
        ? chalk.green(structure.badge)
        : chalk.yellow(structure.badge);
    success(`Structure "${name}" created ${badge} — editor: ${structure.editorMode}`);
  } catch (err) {
    await handleApiError(err);
  }
}
