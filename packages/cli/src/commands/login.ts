import chalk from 'chalk';
import { setUserConfig, setAccessToken, setRefreshToken, setApiUrl, getApiUrl } from '../lib/config.js';
import { startBrowserLogin } from '../lib/browser-login.js';

interface LoginOptions {
  apiUrl?: string;
}

export async function loginCommand(options: LoginOptions) {
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

  // Start the loopback server immediately — this is fast (OS port assignment)
  const handle = startBrowserLogin();
  const port = await handle.port;

  // Load UI + API modules in parallel while we create the state
  const [{ printLogo, printBox, createSpinner, success }, { apiClient, handleApiError }] = await Promise.all([
    import('../lib/ui.js'),
    import('../lib/api.js'),
  ]);

  // Create login state via API (fetch, not browser) and open the browser
  // directly to app.basefyio.com — avoids Safe Browsing warnings on the API domain.
  let loginUrl: string;
  try {
    const stateResult = await apiClient.cliLoginState(port, nonce(handle));
    loginUrl = stateResult.authorizeUrl;
  } catch {
    // Fallback to legacy redirect URL if the new endpoint isn't deployed yet
    loginUrl = `${getApiUrl()}/api/auth/cli-login?port=${port}&nonce=${nonce(handle)}`;
  }

  // Open browser in background — don't block on it
  import('open').then((m) => m.default(loginUrl)).catch(() => null);

  printLogo();

  // Always show the URL so users can paste it manually
  printBox(
    `If your browser does not open, paste this URL manually:\n\n${chalk.cyan(loginUrl)}`,
    { title: 'Browser Login', borderColor: 'cyan' },
  );

  console.log(chalk.gray('Opening your browser for authentication…'));

  const spinner = createSpinner('Waiting for authentication in your browser…');

  // Heartbeat hints — silent waiting feels broken. Surface progressively
  // better diagnostics so the user knows what to check.
  const hint20 = setTimeout(() => {
    spinner.text = 'Still waiting… log in and click "Allow access" in the browser if you haven\'t already.';
  }, 20_000);
  hint20.unref();
  const hint60 = setTimeout(() => {
    spinner.text =
      'Still waiting… make sure you completed the login and clicked "Allow access". ' +
      'If the browser shows "Authentication complete" but this stays here, ' +
      'a firewall may be blocking the loopback callback. Try cancelling (Ctrl+C) and re-running.';
  }, 60_000);
  hint60.unref();
  const hint180 = setTimeout(() => {
    spinner.text =
      'Still waiting (3+ minutes)… the session will time out at 5 minutes. ' +
      'If stuck, press Ctrl+C and run basefyio login again.';
  }, 180_000);
  hint180.unref();

  try {
    const { exchangeCode } = await handle.result;
    clearTimeout(hint20);
    clearTimeout(hint60);
    clearTimeout(hint180);
    spinner.text = 'Completing authentication…';

    // Exchange the one-time code for real tokens. Wrap with our own timeout
    // distinct from the loopback timeout: if the platform API doesn't reply
    // here, the loopback has already done its job and we want to surface the
    // server-side failure quickly rather than sitting on axios' default.
    const tokens = await withTimeout(
      apiClient.cliExchange(exchangeCode, nonce(handle)),
      30_000,
      'Token exchange with the basefyio API timed out. The login callback succeeded ' +
        'but the platform API did not respond. Try again or check your network.',
    );
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
      // Fall back to fetching /me if the JWT decode fails. With a brand-new
      // token this should always succeed; if it doesn't, surface the real
      // error rather than swallowing it.
      const me = await apiClient.getMe();
      setUserConfig({ email: me.email });
      spinner.succeed('Logged in');
      console.log();
      success(`Welcome, ${chalk.cyan(me.email)}`);
    }

    console.log(chalk.gray('  Run  basefyio init  to create a project or  basefyio link  to connect to one'));
  } catch (err: any) {
    clearTimeout(hint20);
    clearTimeout(hint60);
    clearTimeout(hint180);
    spinner.fail('Authentication failed');
    const msg = err?.message || String(err);
    if (msg.toLowerCase().includes('timed out')) {
      console.error(chalk.red(msg));
      console.error(chalk.yellow('Run  basefyio login  again to retry.'));
      process.exit(1);
    }
    if (msg.includes('cancelled')) {
      process.exit(1);
    }
    await handleApiError(err);
  } finally {
    handle.dispose();
  }
}

function nonce(handle: { nonce: string }): string {
  return handle.nonce;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
