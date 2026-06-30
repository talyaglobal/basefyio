import chalk from 'chalk';
import { getProjectConfig, setLocalEnv, unsetLocalEnv, getLocalEnv } from '../lib/config.js';
import { error, success, info, printKeyValue } from '../lib/ui.js';

export async function listSecrets() {
  console.log(chalk.bold.cyan('Environment Secrets\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a basefyio project. Run: basefyio init');
    process.exit(1);
  }

  try {
    const env = await getLocalEnv();
    
    if (Object.keys(env).length === 0) {
      info('No secrets configured');
      console.log();
      console.log(chalk.gray('Add a secret with:'), chalk.cyan('basefyio secrets set KEY VALUE'));
      return;
    }

    // Hide sensitive values
    const masked = Object.entries(env).reduce((acc, [key, value]) => {
      const sensitive = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN'].some(s => 
        key.toUpperCase().includes(s)
      );
      
      acc[key] = sensitive ? maskValue(value) : value;
      return acc;
    }, {} as Record<string, string>);

    printKeyValue(masked);
    
    console.log();
    console.log(chalk.gray(`Total: ${Object.keys(env).length} secret(s)`));
  } catch (err: any) {
    error(`Failed to list secrets: ${err.message}`);
  }
}

export async function setSecret(key: string, value: string) {
  console.log(chalk.bold.cyan('Set Secret\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a basefyio project. Run: basefyio init');
    process.exit(1);
  }

  try {
    await setLocalEnv(key, value);
    success(`Secret ${chalk.cyan(key)} set successfully`);
    
    console.log();
    info('Secret saved to .env file');
  } catch (err: any) {
    error(`Failed to set secret: ${err.message}`);
  }
}

export async function unsetSecret(key: string) {
  console.log(chalk.bold.cyan('Remove Secret\n'));

  const config = await getProjectConfig();
  if (!config) {
    error('Not in a basefyio project. Run: basefyio init');
    process.exit(1);
  }

  try {
    await unsetLocalEnv(key);
    success(`Secret ${chalk.cyan(key)} removed successfully`);
  } catch (err: any) {
    error(`Failed to remove secret: ${err.message}`);
  }
}

function maskValue(value: string): string {
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  
  return value.substring(0, 4) + '*'.repeat(value.length - 8) + value.substring(value.length - 4);
}
