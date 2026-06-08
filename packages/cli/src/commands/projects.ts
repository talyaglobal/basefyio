import inquirer from 'inquirer';
import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { isLoggedIn } from '../lib/config.js';
import { success, error, info, createSpinner, printTable, printHeader } from '../lib/ui.js';

export async function projectsCommand() {
  if (!isLoggedIn()) {
    error('You must be logged in to view projects');
    console.log(chalk.gray('Run: basefyio login'));
    process.exit(1);
  }

  const spinner = createSpinner('Loading projects...');

  try {
    const teams = await apiClient.getTeams();
    const team = teams[0]; // Use first team
    const projects = await apiClient.getProjects(team.id);
    
    spinner.stop();

    if (!projects || projects.length === 0) {
      info('No projects found');
      console.log();
      console.log(chalk.gray('Create your first project with:'), chalk.cyan('basefyio init'));
      return;
    }

    printHeader('Your Projects');
    console.log();

    const rows = projects.map((project: any) => [
      chalk.cyan(project.name),
      project.slug,
      project.status,
      new Date(project.createdAt).toLocaleDateString(),
      project.id,
    ]);

    printTable(
      ['Name', 'Slug', 'Status', 'Created', 'ID'],
      rows
    );

    console.log();
    console.log(chalk.gray(`Total: ${projects.length} project(s)`));
  } catch (err) {
    spinner.fail('Failed to load projects');
    await handleApiError(err);
  }
}

interface CreateProjectOptions {
  name?: string;
  description?: string;
}

export async function createProject(options: CreateProjectOptions) {
  if (!isLoggedIn()) {
    error('You must be logged in to create a project');
    console.log(chalk.gray('Run: basefyio login'));
    process.exit(1);
  }

  try {
    const teams = await apiClient.getTeams();
    const team = teams[0];

    let name = options.name;
    let description = options.description;

    if (!name) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'name',
          message: 'Project name:',
          validate: (input) => input.length > 0 || 'Project name is required',
        },
        {
          type: 'input',
          name: 'description',
          message: 'Description (optional):',
        },
      ]);

      name = answers.name;
      description = answers.description;
    }

    const spinner = createSpinner('Creating project...');

    const project = await apiClient.createProject({
      name: name!,
      description,
      teamId: team.id,
    });

    spinner.succeed('Project created successfully');
    
    console.log();
    console.log(chalk.gray('Name:'), chalk.cyan(project.name));
    console.log(chalk.gray('ID:'), project.id);
    console.log(chalk.gray('Slug:'), project.slug);
    console.log(chalk.gray('Database:'), project.dbName);
    
    console.log();
    console.log(chalk.gray('To start working with this project:'));
    console.log(chalk.cyan('  basefyio init --link'));
  } catch (err) {
    await handleApiError(err);
  }
}

export async function deleteProject(projectId: string) {
  if (!isLoggedIn()) {
    error('You must be logged in to delete a project');
    console.log(chalk.gray('Run: basefyio login'));
    process.exit(1);
  }

  try {
    const spinner = createSpinner('Loading project...');
    const project = await apiClient.getProject(projectId);
    spinner.stop();

    console.log();
    console.log(chalk.yellow('⚠ WARNING: This action cannot be undone!'));
    console.log();
    console.log(chalk.gray('Project:'), chalk.cyan(project.name));
    console.log(chalk.gray('Database:'), project.dbName);
    console.log();

    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to delete this project?',
        default: false,
      },
      {
        type: 'input',
        name: 'confirmName',
        message: `Type the project name "${project.name}" to confirm:`,
        when: (answers) => answers.confirm,
        validate: (input) => 
          input === project.name || `You must type "${project.name}" exactly`,
      },
    ]);

    if (!answers.confirm) {
      info('Deletion cancelled');
      return;
    }

    const deleteSpinner = createSpinner('Deleting project...');
    await apiClient.deleteProject(projectId);
    deleteSpinner.succeed('Project deleted successfully');
  } catch (err) {
    await handleApiError(err);
  }
}
