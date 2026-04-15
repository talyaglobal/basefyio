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

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Kolaybase CLI</title></head>
<body style="font-family:sans-serif;max-width:520px;margin:80px auto;text-align:center">
  <h2 style="color:#10b981">Authentication complete</h2>
  <p>You are now logged in. You may close this tab and return to your terminal.</p>
</body>
</html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Kolaybase CLI</title></head>
<body style="font-family:sans-serif;max-width:520px;margin:80px auto;text-align:center">
  <h2 style="color:#ef4444">Authentication failed</h2>
  <p>${escapeHtml(msg)}</p>
  <p>Please return to your terminal and try again.</p>
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

/**
 * Starts the loopback server, returns the nonce/port needed to build the
 * CLI-login URL, and a promise that resolves once the exchange code arrives.
 */
export function startBrowserLogin(): {
  nonce: string;
  port: Promise<number>;
  result: Promise<BrowserLoginResult>;
} {
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
    res.end(SUCCESS_HTML);
    server.close();
    resolveResult({ exchangeCode: codeParam, nonce, port: actualPort });
  });

  // OS picks the port; bind to loopback literal only
  server.listen(0, '127.0.0.1', () => {
    const actualPort = (server.address() as any)?.port as number;
    resolvePort(actualPort);
  });

  // 5-minute hard timeout so the CLI never hangs forever
  const timeout = setTimeout(() => {
    server.close();
    rejectResult(new Error('Authentication timed out after 5 minutes'));
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

  return { nonce, port: portPromise, result: resultPromise };
}
