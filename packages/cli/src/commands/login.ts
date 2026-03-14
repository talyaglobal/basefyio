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
      name: 'email',
      message: 'Email:',
      validate: (v: string) => (v.includes('@') && v.length > 3) || 'Please enter a valid email',
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
    const data = await apiClient.login(answers.email, answers.password);

    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    setUserConfig({ email: answers.email });

    spinner.succeed('Logged in');
    console.log();
    success(`Welcome, ${chalk.cyan(answers.email)}`);
    console.log(chalk.gray('  Run  kb init  to create a project or  kb link  to connect to one'));
  } catch (err) {
    spinner.fail('Authentication failed');
    handleApiError(err);
  }
}
