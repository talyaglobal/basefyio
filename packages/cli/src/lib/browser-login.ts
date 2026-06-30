/**
 * Browser-based OAuth loopback server for the CLI login flow.
 *
 * Binds to 127.0.0.1:0 (OS-assigned port), opens the Keycloak login page in
 * the user's browser, waits for the one-time exchange code to arrive at
 * GET /callback, then resolves the promise so the caller can do the exchange.
 *
 * Security properties:
 *  - Bound to 127.0.0.1 literal (never 0.0.0.0 / ::)
 *  - Port chosen by OS (listen 0), read via server.address()
 *  - Rejects any path other than /callback (404)
 *  - Rejects requests whose Host header does not match 127.0.0.1:<port>
 *  - Cache-Control: no-store on all responses
 *  - 5-minute timeout; SIGINT/SIGTERM close the server cleanly
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Auth must complete within this window. The user may need to log in to the
 * admin-ui first (enter credentials, 2FA, OAuth redirect) before they can
 * approve the CLI request, so 5 minutes is a reasonable upper bound.
 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Read the CLI version from package.json, tolerating the bundled layout. */
function readCliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../package.json', '../../package.json', './package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(resolve(here, rel), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg?.name === 'basefyio-cli' && pkg.version) return pkg.version;
      } catch {
        // try the next candidate path
      }
    }
  } catch {
    // import.meta.url unavailable — fall through to empty
  }
  return '';
}

/**
 * Terminal "you can close this tab" page shown after the loopback callback
 * fires. Intentionally has no auto-close timer and no close button: browsers
 * block window.close() on tabs the script didn't open, so the countdown only
 * ever produced a dead "Close tab" button. The user closes the tab manually.
 */
function successHtml(): string {
  const cliVersion = readCliVersion();
  const machine = escapeHtml(
    [
      hostname(),
      '@ basefyio',
      cliVersion ? cliVersion : null,
      `node-${process.version}`,
      `${process.platform} (${process.arch})`,
    ]
      .filter(Boolean)
      .join(' '),
  );

  const now = new Date();
  const datePart = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timePart = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const when = escapeHtml(`${datePart} at ${timePart}`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>basefyio CLI</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0; padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
      color: #000; background: #fff;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      -webkit-font-smoothing: antialiased;
    }
    h1 { margin: 0 0 12px; font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
    .sub { margin: 0 0 28px; font-size: 15px; color: #000; }
    .check {
      width: 48px; height: 48px; margin-bottom: 28px; border-radius: 50%;
      background: #000; display: flex; align-items: center; justify-content: center;
    }
    .card {
      width: 100%; max-width: 480px;
      border: 1px solid #eaeaea; border-radius: 10px;
      padding: 16px 18px; font-size: 14px; color: #000;
    }
    .row { display: flex; align-items: flex-start; gap: 10px; }
    .row + .row { margin-top: 10px; }
    .row svg { flex: 0 0 auto; margin-top: 3px; color: #999; }
    .strong { font-weight: 600; }
    .muted { color: #999; }
    .foot { margin-top: 24px; font-size: 13px; color: #999; }
    .foot a { color: #999; text-decoration: none; margin: 0 8px; }
    .foot a:hover { color: #000; }
  </style>
</head>
<body>
  <h1>Authorization successful</h1>
  <p class="sub">You can close this tab.</p>
  <div class="check" aria-hidden="true">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
  </div>
  <div class="card">
    <div class="row">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
      <div><span class="strong">basefyio CLI</span> <span class="muted">${machine}</span></div>
    </div>
    <div class="row">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
      <div>${when}</div>
    </div>
  </div>
  <div class="foot">
    <a href="https://basefyio.com/legal/terms" target="_blank" rel="noopener noreferrer">Terms</a>
    <a href="https://basefyio.com/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
  </div>
</body>
</html>`;
}

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>basefyio CLI</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0; padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
      color: #000; background: #fff;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; -webkit-font-smoothing: antialiased;
    }
    h1 { margin: 0 0 12px; font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
    .sub { margin: 0 0 28px; font-size: 15px; color: #666; max-width: 480px; line-height: 1.55; }
    .mark {
      width: 48px; height: 48px; margin-bottom: 28px; border-radius: 50%;
      background: #000; display: flex; align-items: center; justify-content: center;
    }
  </style>
</head>
<body>
  <h1>Authorization failed</h1>
  <p class="sub">${escapeHtml(msg)}<br>Return to your terminal and try again.</p>
  <div class="mark" aria-hidden="true">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
  </div>
</body>
</html>`;

function escapeHtml(str: string) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function noStore(res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store');
}

export interface BrowserLoginResult {
  /** One-time exchange code received from the loopback callback. */
  exchangeCode: string;
  /** Nonce to include in POST /api/auth/cli/exchange for replay protection. */
  nonce: string;
  /** The loopback port the server bound to. */
  port: number;
}

export interface BrowserLoginHandle {
  nonce: string;
  port: Promise<number>;
  result: Promise<BrowserLoginResult>;
  /**
   * Callers MUST invoke this once the loopback callback has fired and the
   * follow-up exchange has either succeeded or failed. Without it, the
   * 2-minute timeout keeps firing later, the SIGINT handler stays attached,
   * and the listening server may linger holding the port — which causes the
   * next `basefyio login` to fail with EADDRINUSE on the OS-assigned port.
   */
  dispose: () => void;
}

/**
 * Starts the loopback server, returns the nonce/port needed to build the
 * CLI-login URL, and a promise that resolves once the exchange code arrives.
 */
export function startBrowserLogin(): BrowserLoginHandle {
  const nonce = randomBytes(32).toString('hex');
  let resolvePort!: (port: number) => void;
  const portPromise = new Promise<number>((res) => { resolvePort = res; });

  let resolveResult!: (r: BrowserLoginResult) => void;
  let rejectResult!: (e: Error) => void;
  const resultPromise = new Promise<BrowserLoginResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    noStore(res);

    // Ignore favicon requests silently
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const actualPort = (server.address() as any)?.port as number;

    // Validate Host header to block DNS rebinding
    const host = req.headers['host'];
    if (host !== `127.0.0.1:${actualPort}`) {
      res.writeHead(400);
      return res.end('Bad Request');
    }

    // Only handle GET /callback
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404);
      return res.end('Not Found');
    }

    const errorParam = url.searchParams.get('error');
    const codeParam = url.searchParams.get('code');

    if (errorParam) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ERROR_HTML(errorParam));
      server.close();
      rejectResult(new Error(errorParam));
      return;
    }

    if (!codeParam) {
      res.writeHead(400);
      return res.end('Missing code');
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(successHtml());
    server.close();
    resolveResult({ exchangeCode: codeParam, nonce, port: actualPort });
  });

  // OS picks the port; bind to loopback literal only
  server.listen(0, '127.0.0.1', () => {
    const actualPort = (server.address() as any)?.port as number;
    resolvePort(actualPort);
  });

  // Hard timeout so the CLI never hangs forever waiting on a browser that
  // already crashed / was closed / never opened. The reject message includes
  // the loopback URL so the user can see what was being waited on.
  const timeout = setTimeout(() => {
    const actualPort = (server.address() as any)?.port as number;
    server.close();
    rejectResult(
      new Error(
        `Authentication timed out after ${Math.round(LOGIN_TIMEOUT_MS / 60_000)} minutes. ` +
          `The loopback server at http://127.0.0.1:${actualPort}/callback never received ` +
          `the redirect. Check that the browser tab finished loading and that ` +
          `nothing is blocking 127.0.0.1 (corporate firewall, host-overriding extension).`,
      ),
    );
  }, LOGIN_TIMEOUT_MS);
  timeout.unref(); // don't keep the process alive just for the timeout

  // Clean up on SIGINT / SIGTERM so the terminal is left in a good state
  const cleanup = () => {
    clearTimeout(timeout);
    server.close();
    rejectResult(new Error('Login cancelled'));
    process.exit(1);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  const dispose = () => {
    clearTimeout(timeout);
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
    // server.close() already called from inside the request handler in the
    // success path; this guard makes dispose safe to call even if the caller
    // somehow gets here before the request handler fired (e.g. on cliExchange
    // failure between callback receipt and token persistence).
    try { server.close(); } catch { /* noop */ }
  };

  return { nonce, port: portPromise, result: resultPromise, dispose };
}
