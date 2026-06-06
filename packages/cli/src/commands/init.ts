import inquirer from 'inquirer';
import chalk from 'chalk';
import path from 'path';
import { apiClient, handleApiError } from '../lib/api.js';
import { setProjectConfig, isLoggedIn, getProjectConfig, writeEnvFile } from '../lib/config.js';
import { success, error, warning, createSpinner, printHeader } from '../lib/ui.js';

interface InitOptions {
  name?: string;
}

export async function initCommand(options: InitOptions) {
  if (!isLoggedIn()) {
    error('Not logged in. Run:  kb login');
    process.exit(1);
  }

  const existingConfig = await getProjectConfig();
  if (existingConfig?.projectId) {
    warning(`This directory is already linked to project "${existingConfig.projectName}"`);
    console.log(chalk.gray(`  ID: ${existingConfig.projectId}`));
    console.log();
    console.log(chalk.gray('  To link to a different project run:  kb link'));
    console.log(chalk.gray('  To unlink first:                     kb unlink'));
    return;
  }

  const spinner = createSpinner('Loading teams…');

  try {
    const teams = await apiClient.getTeams();
    spinner.stop();

    if (!teams?.length) {
      error('No teams found. Create an account first via the Admin UI.');
      process.exit(1);
    }

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'teamId',
        message: 'Team:',
        choices: teams.map((t: any) => ({
          name: t.personalForUserId ? `${t.name} ${chalk.gray('(personal)')}` : t.name,
          value: t.id,
        })),
        when: teams.length > 1,
      },
      {
        type: 'input',
        name: 'name',
        message: 'Project name:',
        default: options.name || path.basename(process.cwd()),
        validate: (v: string) => v.trim().length > 0 || 'Required',
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description (optional):',
      },
    ]);

    const teamId = answers.teamId || teams[0].id;

    const createSpinnerInstance = createSpinner('Creating project…');

    const project = await apiClient.createProject({
      name: answers.name,
      description: answers.description || undefined,
      teamId,
    });

    createSpinnerInstance.succeed('Project created');

    await setProjectConfig({
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      teamId: project.teamId,
      linkedAt: new Date().toISOString(),
    });

    let connect: Awaited<ReturnType<typeof apiClient.getProjectConnect>> | undefined;
    try {
      connect = await apiClient.getProjectConnect(project.id);
    } catch {
      /* fall back */
    }

    await writeEnvFile(project, connect);

    console.log();
    printHeader('Project ready');
    console.log();
    console.log(`    ${chalk.gray('Name')}          ${project.name}`);
    console.log(`    ${chalk.gray('ID')}            ${project.id}`);
    console.log(`    ${chalk.gray('Database')}      ${project.dbName}`);
    console.log(`    ${chalk.gray('Realm')}         ${project.keycloakRealm}`);
    console.log();
    success('Configuration saved to .kolaybase/config.json');
    success('Credentials saved to .env');
    console.log();
    console.log(chalk.gray('  Next steps:'));
    console.log(chalk.gray('    kb status          — view full connection details'));
    console.log(chalk.gray('    kb inspect         — list database tables'));
    console.log(chalk.gray('    kb gen types       — generate TypeScript types'));
    console.log(chalk.gray('    kb db push         — push a local schema'));
  } catch (err) {
    await handleApiError(err);
  }
}
