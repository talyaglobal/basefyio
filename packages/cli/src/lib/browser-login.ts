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

/**
 * Auth must complete within this window. The user may need to log in to the
 * admin-ui first (enter credentials, 2FA, OAuth redirect) before they can
 * approve the CLI request, so 5 minutes is a reasonable upper bound.
 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>basefyio CLI</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 560px;
           margin: 80px auto; text-align: center; color: #1f2937; }
    h2 { color: #10b981; margin-bottom: 8px; }
    .hint { color: #6b7280; font-size: 13px; margin-top: 32px; line-height: 1.55; }
    .hint code { background:#f3f4f6; padding:1px 6px; border-radius:4px; font-size:12px; }
    #countdown { color: #6b7280; font-size: 14px; margin-top: 18px; }
    button { background:#10b981; color:#fff; border:0; padding:10px 18px;
             border-radius:8px; font-size:14px; cursor:pointer; margin-top:8px; }
  </style>
</head>
<body>
  <h2>Authentication complete</h2>
  <p>You are now logged in. Return to your terminal to continue.</p>
  <div id="countdown">This tab will try to close in <b id="t">3</b>s…</div>
  <button onclick="window.close()">Close tab</button>
  <p class="hint">
    The <code>127.0.0.1</code> URL is normal — the basefyio CLI runs a
    short-lived local server to receive the auth code from Keycloak.
    This is the OAuth 2.0 loopback flow (RFC 8252) used by every native CLI.
  </p>
  <script>
    var n = 3;
    var el = document.getElementById('t');
    var iv = setInterval(function () {
      n -= 1;
      if (el) el.textContent = String(Math.max(n, 0));
      if (n <= 0) {
        clearInterval(iv);
        // Try multiple close strategies
        window.close();
        // Navigate to about:blank first — some browsers allow closing after that
        setTimeout(function () {
          window.open('about:blank', '_self');
          window.close();
        }, 300);
        // Final fallback: show "safe to close" message
        setTimeout(function () {
          document.getElementById('countdown').textContent =
            'You can safely close this tab now.';
        }, 800);
      }
    }, 1000);
  </script>
</body>
</html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>basefyio CLI</title></head>
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
    res.end(SUCCESS_HTML);
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
