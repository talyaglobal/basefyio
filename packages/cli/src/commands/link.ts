import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs/promises';
import { apiClient, handleApiError } from '../lib/api.js';
import { setProjectConfig, isLoggedIn, writeEnvFile } from '../lib/config.js';
import { success, error, createSpinner } from '../lib/ui.js';

interface LinkOptions {
  projectId?: string;
}

/**
 * Order the picker so the most recently created project is first (and therefore
 * pre-selected by the list prompt) — the one you just made is what you usually
 * want to link. Projects with no creation date sink below the dated ones, and
 * ties fall back to a locale-aware name sort for a stable order.
 */
export function sortProjectsByNewest<T extends { createdAt?: string; name: string }>(
  projects: T[],
): T[] {
  const ts = (p: { createdAt?: string }) => {
    const t = p.createdAt ? new Date(p.createdAt).getTime() : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  return [...projects].sort(
    (a, b) => ts(b) - ts(a) || a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }),
  );
}

export async function linkCommand(options: LinkOptions) {
  if (!isLoggedIn()) {
    error('Not logged in. Run:  basefyio login');
    process.exit(1);
  }

  try {
    let projectId = options.projectId;

    if (!projectId) {
      const spinner = createSpinner('Loading projects…');
      const teams = await apiClient.getTeams();

      let allProjects: any[] = [];
      for (const team of teams) {
        const projects = await apiClient.getProjects(team.id);
        allProjects.push(
          ...projects.map((p: any) => ({ ...p, teamName: team.name })),
        );
      }
      spinner.stop();

      allProjects = sortProjectsByNewest(allProjects);

      if (!allProjects.length) {
        error('No projects found. Create one first:  basefyio init');
        process.exit(1);
      }

      const { selected } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selected',
          message: 'Select a project to link:',
          choices: allProjects.map((p, i) => ({
            name:
              `${p.name}  ${chalk.gray(p.slug)}  ${chalk.gray('— ' + p.teamName)}` +
              (i === 0 ? chalk.green('  · newest') : ''),
            value: p.id,
          })),
        },
      ]);

      projectId = selected;
    }

    const spinner = createSpinner('Linking…');
    const project = await apiClient.getProject(projectId!);

    let connect: Awaited<ReturnType<typeof apiClient.getProjectConnect>> | undefined;
    try {
      connect = await apiClient.getProjectConnect(projectId!);
    } catch {
      /* older API — fall back to project row URLs */
    }

    await setProjectConfig({
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      teamId: project.teamId,
      linkedAt: new Date().toISOString(),
    });

    await writeEnvFile(project, connect);

    spinner.succeed(`Linked to ${chalk.cyan(project.name)}`);
    console.log();
    console.log(`    ${chalk.gray('Database')}      ${project.dbName}`);
    console.log(`    ${chalk.gray('Realm')}         ${project.keycloakRealm}`);
    console.log();
    success('Credentials saved to .env');
    console.log(chalk.gray('  Run  basefyio status  to see full connection details'));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function unlinkProject() {
  try {
    await fs.rm('.basefyio', { recursive: true, force: true });
    success('Project unlinked');
  } catch (err: any) {
    error(`Failed to unlink: ${err.message}`);
  }
}
