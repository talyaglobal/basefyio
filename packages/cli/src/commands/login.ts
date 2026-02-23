import inquirer from 'inquirer';
import chalk from 'chalk';
import { apiClient, handleApiError } from '../lib/api.js';
import { setUserConfig, setAccessToken, setRefreshToken, setApiUrl } from '../lib/config.js';
import { success, createSpinner, printLogo } from '../lib/ui.js';

interface LoginOptions {
  apiUrl?: string;
}

export async function loginCommand(options: LoginOptions) {
  printLogo();

  if (options.apiUrl) {
    setApiUrl(options.apiUrl);
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'username',
      message: 'Username:',
      validate: (v: string) => v.length > 0 || 'Required',
    },
    {
      type: 'password',
      name: 'password',
      message: 'Password:',
      mask: '*',
      validate: (v: string) => v.length > 0 || 'Required',
    },
  ]);

  const spinner = createSpinner('Authenticating…');

  try {
    const data = await apiClient.login(answers.username, answers.password);

    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    setUserConfig({ username: answers.username });

    spinner.succeed('Logged in');
    console.log();
    success(`Welcome, ${chalk.cyan(answers.username)}`);
    console.log(chalk.gray('  Run  kb init  to create a project or  kb link  to connect to one'));
  } catch (err) {
    spinner.fail('Authentication failed');
    handleApiError(err);
  }
}
