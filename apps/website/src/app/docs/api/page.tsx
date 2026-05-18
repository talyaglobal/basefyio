import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "Kolaybase REST API: authentication headers, PostgREST-style queries, storage, and project-scoped endpoints.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/api", {
    title: "API Reference",
    description: pageDescription,
    openGraph: {
      title: "API Reference | Kolaybase Docs",
      description: pageDescription,
    },
  });
}

export default function ApiDocs() {
  const apiRoot = getPublicApiUrl();

  return (
    <div>
      <h1>API Reference</h1>
      <p>
        The Kolaybase REST API is available at{" "}
        <code>
          {apiRoot}/api
        </code>
        . All project-scoped
        endpoints require either a JWT token or an API key passed via the{" "}
        <code>apikey</code> header.
      </p>

      <h2>Authentication Headers</h2>
      <table>
        <thead>
          <tr>
            <th>Header</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>Authorization: Bearer &lt;jwt&gt;</code></td>
            <td>Platform JWT from login/signup</td>
          </tr>
          <tr>
            <td><code>apikey: &lt;anon-key | service-key&gt;</code></td>
            <td>Project API key for SDK/public endpoints</td>
          </tr>
        </tbody>
      </table>

      {/* ── Public REST API ─────────────────────────── */}
      <h2>Public REST API (PostgREST-style)</h2>
      <p>
        These endpoints use the API key and follow a PostgREST-style query
        interface. Base path: <code>/api/rest/v1</code>.
      </p>

      <h3>Select rows</h3>
      <pre><code>{`GET /api/rest/v1/:table?select=*&id=eq.1

Headers:
  apikey: <anon-key>

Query params:
  select    — columns to return (default: *)
  <column>  — filter value: eq.<v>, neq.<v>, gt.<v>, gte.<v>, lt.<v>, lte.<v>, like.<pattern>, ilike.<pattern>, is.null|true|false, in.(a,b,c)
  order     — column.asc or column.desc (comma-separated)
  limit     — max rows
  offset    — skip rows`}</code></pre>

      <h3>Insert rows</h3>
      <pre><code>{`POST /api/rest/v1/:table
Headers:
  apikey: <service-key>
  Content-Type: application/json
  Prefer: return=representation   # optional

Body: { "column1": "value", "column2": 123 }
  — or array for bulk insert —
Body: [{ "column1": "a" }, { "column1": "b" }]`}</code></pre>

      <h3>Update rows</h3>
      <pre><code>{`PATCH /api/rest/v1/:table?column=eq.value
Headers:
  apikey: <service-key>
  Content-Type: application/json
  Prefer: return=representation   # optional

Body: { "column1": "new-value" }`}</code></pre>

      <h3>Delete rows</h3>
      <pre><code>{`DELETE /api/rest/v1/:table?column=eq.value
Headers:
  apikey: <service-key>
  Prefer: return=representation   # optional`}</code></pre>

      {/* ── SDK Auth ────────────────────────────────── */}
      <h2>SDK Auth Endpoints</h2>
      <p>
        Project user authentication. Base path: <code>/api/rest/v1/auth</code>.
        Requires <code>apikey</code> header.
      </p>

      <h3>Sign Up</h3>
      <pre><code>{`POST /api/rest/v1/auth/signup
Body: {
  "email": "user@example.com",
  "password": "secret123",
  "firstName": "John",   // optional
  "lastName": "Doe"      // optional
}

Response: { accessToken, refreshToken, expiresIn, user }`}</code></pre>

      <h3>Sign In</h3>
      <pre><code>{`POST /api/rest/v1/auth/signin
Body: { "email": "user@example.com", "password": "secret123" }

Response: { accessToken, refreshToken, expiresIn, user }`}</code></pre>

      <h3>Verify Email</h3>
      <pre><code>{`POST /api/rest/v1/auth/verify-email
Body: { "otp": "123456" }`}</code></pre>

      <h3>Forgot Password</h3>
      <pre><code>{`POST /api/rest/v1/auth/forgot-password
Body: { "email": "user@example.com" }`}</code></pre>

      <h3>Reset Password</h3>
      <pre><code>{`POST /api/rest/v1/auth/reset-password
Body: { "otp": "123456", "newPassword": "newsecret123" }`}</code></pre>

      <h3>Magic Link</h3>
      <pre><code>{`POST /api/rest/v1/auth/magic-link
Body: { "email": "user@example.com" }

POST /api/rest/v1/auth/magic-link/verify
Body: { "otp": "123456" }`}</code></pre>

      <h3>OAuth</h3>
      <pre><code>{`GET /api/rest/v1/auth/signin/:provider?redirect_to=https://myapp.com/callback
  — provider: google, github
  — Returns: { url } — redirect user to this URL

GET /api/rest/v1/auth/callback/:projectId/:provider
  — Keycloak redirects here after OAuth
  — Redirects to your app with tokens in URL hash`}</code></pre>

      <h3>Refresh Token</h3>
      <pre><code>{`POST /api/rest/v1/auth/refresh
Body: { "refreshToken": "..." }

Response: { accessToken, refreshToken, expiresIn }`}</code></pre>

      <h3>Get Current User</h3>
      <pre><code>{`GET /api/rest/v1/auth/me
Headers:
  Authorization: Bearer <access-token>

Response: { id, email, username, emailVerified, ... }`}</code></pre>

      <h3>Other Auth Endpoints</h3>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/change-email</code></td><td>Request email change</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/change-email/verify</code></td><td>Confirm email change</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/reauth</code></td><td>Request re-authentication</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/reauth/verify</code></td><td>Verify re-auth OTP</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/invite</code></td><td>Invite user (service key only)</td></tr>
        </tbody>
      </table>

      {/* ── Project Management ──────────────────────── */}
      <h2>Project Management</h2>
      <p>Requires platform JWT. Base path: <code>/api/projects</code>.</p>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>POST</td><td><code>/projects</code></td><td>Create project</td></tr>
          <tr><td>GET</td><td><code>/projects?teamId=...</code></td><td>List projects</td></tr>
          <tr><td>GET</td><td><code>/projects/:id</code></td><td>Get project details</td></tr>
          <tr><td>DELETE</td><td><code>/projects/:id</code></td><td>Delete project</td></tr>
        </tbody>
      </table>

      {/* ── Table Management ────────────────────────── */}
      <h2>Table Management</h2>
      <p>Requires JWT or API key.</p>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/projects/:id/tables</code></td><td>List tables</td></tr>
          <tr><td>POST</td><td><code>/projects/:id/tables</code></td><td>Create table</td></tr>
          <tr><td>DELETE</td><td><code>/projects/:id/tables/:name</code></td><td>Drop table</td></tr>
          <tr><td>GET</td><td><code>/projects/:id/tables/:name/columns</code></td><td>List columns</td></tr>
          <tr><td>POST</td><td><code>/projects/:id/tables/:name/columns</code></td><td>Add column</td></tr>
          <tr><td>PUT</td><td><code>/projects/:id/tables/:name/columns/:col</code></td><td>Edit column</td></tr>
          <tr><td>DELETE</td><td><code>/projects/:id/tables/:name/columns/:col</code></td><td>Delete column</td></tr>
          <tr><td>GET</td><td><code>/projects/:id/tables/:name/rows</code></td><td>Get rows</td></tr>
          <tr><td>POST</td><td><code>/projects/:id/tables/:name/rows</code></td><td>Insert row</td></tr>
          <tr><td>PUT</td><td><code>/projects/:id/tables/:name/rows</code></td><td>Update row (body includes <code>pkWhere</code> + <code>data</code>)</td></tr>
          <tr><td>DELETE</td><td><code>/projects/:id/tables/:name/rows</code></td><td>Delete row</td></tr>
          <tr><td>GET</td><td><code>/projects/:id/tables/:name/foreign-keys</code></td><td>List FK</td></tr>
          <tr><td>POST</td><td><code>/projects/:id/tables/:name/foreign-keys</code></td><td>Add FK</td></tr>
          <tr><td>DELETE</td><td><code>/projects/:id/tables/:name/foreign-keys/:fk</code></td><td>Delete FK</td></tr>
        </tbody>
      </table>

      {/* ── Storage ─────────────────────────────────── */}
      <h2>Storage</h2>
      <p>S3-compatible file storage. Requires JWT or API key.</p>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/projects/:id/storage/buckets</code></td><td>List buckets</td></tr>
          <tr><td>POST</td><td><code>/projects/:id/storage/buckets</code></td><td>Create bucket</td></tr>
          <tr><td>DELETE</td><td><code>/projects/:id/storage/buckets/:name</code></td><td>Delete bucket</td></tr>
          <tr><td>PATCH</td><td><code>/projects/:id/storage/buckets/:name</code></td><td>Toggle public</td></tr>
          <tr><td>GET</td><td><code>/projects/:id/storage/buckets/:name/objects?prefix=</code></td><td>List objects</td></tr>
          <tr><td>POST</td><td><code>/projects/:id/storage/buckets/:name/objects?path=</code></td><td>Upload (multipart)</td></tr>
          <tr><td>GET</td><td><code>/projects/:id/storage/buckets/:name/objects/download?path=</code></td><td>Download object</td></tr>
          <tr><td>GET</td><td><code>/projects/:id/storage/buckets/:name/objects/url?path=</code></td><td>Signed URL</td></tr>
          <tr><td>DELETE</td><td><code>/projects/:id/storage/buckets/:name/objects</code></td><td>Delete objects</td></tr>
        </tbody>
      </table>

      {/* ── SQL ─────────────────────────────────────── */}
      <h2>SQL Execution</h2>
      <pre><code>{`POST /api/sql/execute
Headers:
  Authorization: Bearer <jwt>
Body: {
  "projectId": "...",
  "query": "SELECT * FROM users LIMIT 10"
}

Response: { columns: [...], rows: [...], rowCount, duration }`}</code></pre>
    </div>
  );
}
