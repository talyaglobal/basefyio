import chalk from 'chalk';
import open from 'open';
import { apiClient, handleApiError } from '../lib/api.js';
import { setUserConfig, setAccessToken, setRefreshToken, setApiUrl, getApiUrl } from '../lib/config.js';
import { success, createSpinner, printLogo, printBox } from '../lib/ui.js';
import { startBrowserLogin } from '../lib/browser-login.js';

interface LoginOptions {
  apiUrl?: string;
}

export async function loginCommand(options: LoginOptions) {
  printLogo();

  if (options.apiUrl) {
    setApiUrl(options.apiUrl);
  }

  // Headless environments (CI, SSH sessions without X display) can't open a browser
  const isHeadless =
    !process.stdout.isTTY ||
    !!process.env.CI ||
    !!process.env.SSH_TTY;

  if (isHeadless) {
    console.error(chalk.red('Browser login requires an interactive terminal.'));
    console.error(chalk.gray('CI support is planned — use an access token via a future `--token` flag.'));
    process.exit(1);
  }

  // Start the loopback server and get the nonce + port
  const { nonce, port: portPromise, result: loginResult } = startBrowserLogin();
  const port = await portPromise;

  // Build the CLI-login URL that the backend will handle
  const loginUrl = `${getApiUrl()}/api/auth/cli-login?port=${port}&nonce=${nonce}`;

  // Try to open the URL in the default browser; fall back to printing it
  try {
    await open(loginUrl);
    console.log(chalk.gray('Opening your browser for authentication…'));
  } catch {
    printBox(
      `Open this URL in your browser to continue:\n\n${chalk.cyan(loginUrl)}`,
      { title: 'Browser Login', borderColor: 'cyan' },
    );
  }

  const spinner = createSpinner('Waiting for authentication in your browser…');

  try {
    const { exchangeCode } = await loginResult;
    spinner.text = 'Completing authentication…';

    // Exchange the one-time code for real tokens
    const tokens = await apiClient.cliExchange(exchangeCode, nonce);
    setAccessToken(tokens.accessToken);
    setRefreshToken(tokens.refreshToken);

    // Decode the JWT to get the user's email (no extra network call needed)
    const emailFromJwt = parseEmailFromJwt(tokens.accessToken);

    if (emailFromJwt) {
      setUserConfig({ email: emailFromJwt });
      spinner.succeed('Logged in');
      console.log();
      success(`Welcome, ${chalk.cyan(emailFromJwt)}`);
    } else {
      // Fall back to fetching /me if the JWT decode fails
      const me = await apiClient.getMe();
      setUserConfig({ email: me.email });
      spinner.succeed('Logged in');
      console.log();
      success(`Welcome, ${chalk.cyan(me.email)}`);
    }

    console.log(chalk.gray('  Run  kb init  to create a project or  kb link  to connect to one'));
  } catch (err: any) {
    spinner.fail('Authentication failed');
    const msg = err?.message || String(err);
    if (msg.includes('timed out')) {
      console.error(chalk.red('Login timed out. Please run  kb login  again.'));
      process.exit(1);
    }
    if (msg.includes('cancelled')) {
      process.exit(1);
    }
    handleApiError(err);
  }
}

/** Decode a JWT payload without verifying the signature (verification is done server-side). */
function parseEmailFromJwt(token: string): string | null {
  try {
    const [, payloadB64] = token.split('.');
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}
