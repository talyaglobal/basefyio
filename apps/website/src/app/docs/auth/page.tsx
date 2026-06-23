import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getAppPortalUrl } from "@/lib/site-url";

const pageDescription =
  "Add authentication to your app with basefyio: email & password, email verification, password reset, magic links, and social login (Google, GitHub) — via the SDK or REST API.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/auth", {
    title: "Authentication",
    description: pageDescription,
    openGraph: {
      title: "Authentication | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function AuthDocs() {
  const appUrl = getAppPortalUrl();

  return (
    <div>
      <h1>Authentication</h1>
      <p>
        Every basefyio project ships with its own authentication service — a
        dedicated, isolated user directory for <strong>your app&apos;s end users</strong>.
        These are <em>not</em> the same as your basefyio dashboard account: your
        customers sign up and sign in to <em>your</em> application, and basefyio
        issues them JSON Web Tokens (JWTs) you can use to protect data with{" "}
        <a href="/docs/security">Row-Level Security</a>.
      </p>
      <p>
        You get email &amp; password, email verification, password reset, magic
        links, and social login (Google, GitHub) out of the box — from the SDK or
        the REST API.
      </p>

      {/* ── Setup ──────────────────────────────────────── */}
      <h2>Setup</h2>
      <p>
        Install the SDK and create a client with your project ID and{" "}
        <strong>anon key</strong> (found under <strong>Overview → API Keys</strong>{" "}
        in the <a href={appUrl}>dashboard</a>). The anon key is safe to ship in a
        browser; data access is still governed by your RLS policies.
      </p>
      <pre><code>{`npm install basefyio-js`}</code></pre>
      <pre><code>{`import { createClient } from 'basefyio-js'

const bf = createClient({
  projectId: 'your-project-id',
  apiKey: 'your-anon-key',
})`}</code></pre>
      <p>All auth methods live under <code>bf.auth</code>.</p>

      {/* ── Email & password ───────────────────────────── */}
      <h2>Email &amp; password</h2>
      <p>Sign a new user up, then sign them in. The SDK stores the session and refreshes it automatically.</p>
      <pre><code>{`// Sign up
const { data, error } = await bf.auth.signUp({
  email: 'jane@example.com',
  password: 'a-strong-password',
  firstName: 'Jane',   // optional
  lastName: 'Doe',     // optional
})

// Sign in
const { data, error } = await bf.auth.signIn({
  email: 'jane@example.com',
  password: 'a-strong-password',
})

// The signed-in user
const { data: user } = await bf.auth.getUser()

// Sign out (clears the local session)
await bf.auth.signOut()`}</code></pre>
      <p>
        Every method returns <code>{`{ data, error }`}</code> — check{" "}
        <code>error</code> before using <code>data</code>. One account per email is
        enforced per project, so a duplicate <code>signUp</code> returns an error.
      </p>

      {/* ── Sessions ───────────────────────────────────── */}
      <h2>Sessions &amp; tokens</h2>
      <p>
        After sign-in the SDK keeps the session in memory and refreshes the access
        token before it expires. Read it any time, attach a token to your own
        backend calls, or react to auth changes:
      </p>
      <pre><code>{`const session = bf.auth.getSession()
const token = bf.auth.getAccessToken()   // send as: Authorization: Bearer <token>

// React to sign-in / sign-out / token refresh
const { unsubscribe } = bf.auth.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'EMAIL_VERIFIED' | ...
})`}</code></pre>

      {/* ── Email verification ─────────────────────────── */}
      <h2>Email verification</h2>
      <p>
        If <strong>Require email verification</strong> is on (project →{" "}
        <strong>Auth → Settings</strong>), new users receive a code by email.
        Confirm it with the OTP they enter:
      </p>
      <pre><code>{`const { error } = await bf.auth.verifyEmail('482917')`}</code></pre>

      {/* ── Password reset ─────────────────────────────── */}
      <h2>Password reset</h2>
      <p>Send a reset code to the user&apos;s email, then set a new password with that code:</p>
      <pre><code>{`// 1. Email the user a reset code
await bf.auth.forgotPassword('jane@example.com')

// 2. User enters the code; set the new password
await bf.auth.resetPassword('482917', 'a-new-strong-password')`}</code></pre>

      {/* ── Magic links ────────────────────────────────── */}
      <h2>Magic links (passwordless)</h2>
      <p>Email a one-time sign-in code, then exchange it for a session:</p>
      <pre><code>{`await bf.auth.sendMagicLink('jane@example.com')
const { data } = await bf.auth.verifyMagicLink('482917')`}</code></pre>

      {/* ── Social login ───────────────────────────────── */}
      <h2>Social login (Google &amp; GitHub)</h2>
      <p>
        Once a provider is enabled for your project (see below),
        start the flow with <code>signInWithProvider</code>. The browser is
        redirected to the provider and back to your app:
      </p>
      <pre><code>{`// Kicks off the redirect to Google / GitHub
await bf.auth.signInWithProvider('google', {
  redirectTo: '/dashboard',   // a path in YOUR app
})

// On the page the user lands back on, finish the flow:
const tokens = bf.auth.handleProviderCallback()  // reads the URL, stores the session`}</code></pre>

      <h3>Enabling a provider</h3>
      <p>
        In the <a href={appUrl}>dashboard</a> open your project →{" "}
        <strong>Auth → Providers</strong>, pick Google or GitHub, paste the{" "}
        <strong>Client ID</strong> and <strong>Client Secret</strong> from the
        provider&apos;s developer console, and enable it.
      </p>
      <div
        style={{
          borderLeft: "3px solid #f59e0b",
          background: "rgba(245, 158, 11, 0.08)",
          padding: "0.75rem 1rem",
          borderRadius: "0.375rem",
          margin: "1rem 0",
        }}
      >
        <p style={{ margin: 0 }}>
          <strong>Important — the redirect URI.</strong> In your Google Cloud
          Console / GitHub OAuth app, the <strong>Authorized redirect URI</strong>{" "}
          must be the exact URL shown in the Providers panel. basefyio brokers the
          login through its auth service, so that URL looks like:
        </p>
        <pre style={{ marginBottom: 0 }}><code>{`https://auth.basefyio.com/realms/<your-realm>/broker/google/endpoint`}</code></pre>
        <p style={{ marginBottom: 0 }}>
          Copy it straight from the Providers panel (there&apos;s a copy button) —
          a mismatch here is the #1 reason social login fails with{" "}
          <code>redirect_uri_mismatch</code>.
        </p>
      </div>

      {/* ── Managing users ─────────────────────────────── */}
      <h2>Managing users from the dashboard</h2>
      <p>
        Project → <strong>Auth → Users</strong> lists everyone who has signed up.
        You can add a user manually (<strong>Add User</strong>), reset a password,
        edit their profile, or remove them. Adding a user with an email that
        already exists is rejected.
      </p>

      {/* ── REST API ───────────────────────────────────── */}
      <h2>REST API</h2>
      <p>
        Not using JavaScript? Every method maps to a REST endpoint under{" "}
        <code>/rest/v1/auth/</code>. Send your anon key as the{" "}
        <code>apikey</code> header (or <code>?apikey=</code> query param).
      </p>
      <table>
        <thead>
          <tr><th>Method &amp; path</th><th>Body</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr><td><code>POST /rest/v1/auth/signup</code></td><td><code>{`{ email, password, firstName?, lastName? }`}</code></td><td>Create a user, return tokens</td></tr>
          <tr><td><code>POST /rest/v1/auth/signin</code></td><td><code>{`{ email, password }`}</code></td><td>Sign in, return tokens</td></tr>
          <tr><td><code>POST /rest/v1/auth/verify-email</code></td><td><code>{`{ otp }`}</code></td><td>Confirm an email code</td></tr>
          <tr><td><code>POST /rest/v1/auth/forgot-password</code></td><td><code>{`{ email }`}</code></td><td>Email a reset code</td></tr>
          <tr><td><code>POST /rest/v1/auth/reset-password</code></td><td><code>{`{ otp, newPassword }`}</code></td><td>Set a new password</td></tr>
          <tr><td><code>POST /rest/v1/auth/magic-link</code></td><td><code>{`{ email }`}</code></td><td>Email a magic-link code</td></tr>
          <tr><td><code>POST /rest/v1/auth/magic-link/verify</code></td><td><code>{`{ otp }`}</code></td><td>Exchange code for tokens</td></tr>
          <tr><td><code>POST /rest/v1/auth/refresh</code></td><td><code>{`{ refreshToken }`}</code></td><td>Refresh the access token</td></tr>
          <tr><td><code>GET /rest/v1/auth/me</code></td><td>—</td><td>Current user (Bearer token)</td></tr>
          <tr><td><code>GET /rest/v1/auth/signin/:provider</code></td><td>—</td><td>Start a social-login redirect</td></tr>
        </tbody>
      </table>
      <pre><code>{`curl -X POST "https://api.basefyio.com/rest/v1/auth/signin" \\
  -H "apikey: YOUR_ANON_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"jane@example.com","password":"a-strong-password"}'`}</code></pre>

      {/* ── Securing data ──────────────────────────────── */}
      <h2>Using the token to protect data</h2>
      <p>
        Send the user&apos;s access token with your data requests and basefyio
        evaluates your <a href="/docs/security">Row-Level Security</a> policies as
        that user — so people only ever read and write the rows they&apos;re
        allowed to. The SDK attaches the token automatically once the user is
        signed in.
      </p>
    </div>
  );
}
