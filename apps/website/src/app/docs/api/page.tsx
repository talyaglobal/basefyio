import type { Metadata } from "next";
import { docsMetadata } from "../docs-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio REST API: authentication headers, auto-generated queries, storage, and project-scoped endpoints.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/api", "API Reference", pageDescription);
}

export default function ApiDocs() {
  const apiRoot = getPublicApiUrl();

  return (
    <div>
      <h1>API Reference</h1>
      <p>
        The basefyio REST API is available at{" "}
        <code>
          {apiRoot}/api
        </code>
        . All project-scoped
        endpoints require either a JWT token or an API key passed via the{" "}
        <code>apikey</code> header.
      </p>

      <h2>Authentication Headers</h2>
      <div className="docs-table"><table>
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
      </table></div>

      {/* ── Public REST API ─────────────────────────── */}
      <h2>Public REST API (Auto-generated)</h2>
      <p>
        These endpoints use the API key and follow an auto-generated query
        interface. Base path: <code>/api/rest/v1</code>.
      </p>

      <h3>Select rows</h3>
      <pre><code>{`GET /api/rest/v1/:table?select=*&id=eq.1

Headers:
  apikey: <anon-key>

Query params:
  select    — columns to return (default: *)
  <column>  — filter value: eq.<v>, neq.<v>, gt.<v>, gte.<v>, lt.<v>, lte.<v>, like.<pattern>, ilike.<pattern>, is.null|true|false, in.(a,b,c)
  order     — column.asc or column.desc (comma-separated); add .nullsfirst / .nullslast
              (by default NULLs sort last ascending, first descending)
  limit     — max rows (at most 1000 per request)
  offset    — skip rows
  count     — exact | planned | estimated | none (same as Prefer: count=…)

Response: { "data": [ … ], "count": 42 }
Headers:  Content-Range: 0-9/42   (Range: 0-9 works as limit/offset too)
          Accept: text/csv returns CSV instead of JSON`}</code></pre>
      <p>
        <code>count</code> is free when the page holds every match, exact up to 10,000
        matching rows, and the planner&apos;s estimate beyond that; send
        <code>Prefer: count=exact</code> for an exact total on a large table, or
        <code>count=none</code> to skip it. <code>bigint</code> and <code>numeric</code> values
        of the row arrive as JSON strings, so no digit is lost. A malformed query (a filter
        without an operator, an unknown operator, a <code>limit</code> that is not a whole
        number) is a 400 that names the problem.
      </p>

      <h3>Insert rows</h3>
      <pre><code>{`POST /api/rest/v1/:table
Headers:
  apikey: <service-key>
  Content-Type: application/json
  Prefer: return=representation   # optional

Body: { "column1": "value", "column2": 123 }
  — or array for bulk insert —
Body: [{ "column1": "a" }, { "column1": "b" }]

Response: { "count": 2 }   — with return=representation, the rows: [ { … }, { … } ]
          return=minimal answers 201 with no body`}</code></pre>
      <p>
        A large batch is split into statements under Postgres&apos; limit of 65,535 values,
        in one transaction — it is stored whole or not at all. Writes answer with a count or
        the rows, not the <code>{`{ data, count }`}</code> envelope of a read;
        <code>?select=id,title</code> narrows the rows returned.
      </p>

      <h3>Upsert rows</h3>
      <pre><code>{`POST /api/rest/v1/:table?on_conflict=slug     # on_conflict optional: the primary key by default
Headers:
  apikey: <service-key>
  Content-Type: application/json
  Prefer: resolution=merge-duplicates, return=representation
          # or resolution=ignore-duplicates to keep existing rows

Body: [{ "slug": "milk", "title": "Buy milk" }]`}</code></pre>
      <p>
        Inserts each row, or updates the row that already has the same key. It runs under
        the caller&apos;s role like an insert, so row-level policies apply.
      </p>

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
      <p>
        <code>PATCH</code> and <code>DELETE</code> need at least one filter, so a missing
        <code>?id=eq.…</code> cannot touch every row. <code>Prefer: return=minimal</code>
        answers 204 with no body.
      </p>

      <h3 id="rpc">Call a database function (rpc)</h3>
      <pre><code>{`POST /api/rest/v1/rpc/:function
Headers:
  apikey: <anon-key>          # plus Authorization: Bearer <user token> to act as the user
  Content-Type: application/json

Body: { "name": "world" }     # the arguments by name (not wrapped in "args")

Response (200): [ { "hello": "Hello world" } ]`}</code></pre>
      <p>
        The function must be in the <code>public</code> schema. Arguments with a default may
        be left out; arguments that fit no version of the function are a 400 listing the
        signatures that exist, and an error the function raises is a 400 with its message. A
        <code>SECURITY DEFINER</code> function cannot be called with the anon key alone — send
        a signed-in user&apos;s token or use the service key from your server. From the SDK:
        <code>{`const { data, error } = await bf.rpc('hello', { name: 'world' })`}</code>.
      </p>

      <h3>Errors</h3>
      <p>
        Errors are <code>{`{ statusCode, message, code }`}</code>. For a database error
        <code>code</code> is Postgres&apos; SQLSTATE (<code>23505</code> duplicate key,
        <code>22P02</code> invalid input, <code>42501</code> missing privilege); the message
        names the column, constraint or type involved, and tells a missing table grant apart
        from a row-level policy refusal. Malformed JSON in a body is a 400, and error responses
        carry CORS headers, so a browser can read them.
      </p>

      {/* ── SDK Auth ────────────────────────────────── */}
      <h2 id="auth">SDK Auth Endpoints</h2>
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
  — the OAuth provider returns here after sign-in
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
      <div className="docs-table"><table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/change-email</code></td><td>Request email change</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/change-email/verify</code></td><td>Confirm email change</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/reauth</code></td><td>Request re-authentication</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/reauth/verify</code></td><td>Verify re-auth OTP</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/invite</code></td><td>Invite user (service key only)</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/signin/anonymous</code></td><td>Session without an account (off unless the project allows it)</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/anonymous/upgrade</code></td><td>Turn an anonymous user into an email/password account</td></tr>
          <tr><td>GET</td><td><code>/api/rest/v1/auth/mfa</code></td><td>Second-factor status of the signed-in user</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/mfa/enroll</code></td><td>Start enrolling an authenticator app</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/mfa/verify-enrollment</code></td><td>Confirm the first code; returns recovery codes</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/mfa/challenge</code></td><td>Complete a sign-in that asked for a second factor</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/mfa/disable</code></td><td>Turn the second factor off</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/auth/mfa/recovery-codes</code></td><td>Replace the recovery codes</td></tr>
        </tbody>
      </table></div>

      {/* ── Project Management ──────────────────────── */}
      <h2>Project Management</h2>
      <p>Requires a dashboard session (platform JWT) or an account API token.</p>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>POST</td><td><code>/api/projects</code></td><td>Create project</td></tr>
          <tr><td>GET</td><td><code>/api/projects?teamId=...</code></td><td>List projects</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:id</code></td><td>Get project details</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:id</code></td><td>Delete project</td></tr>
        </tbody>
      </table></div>

      {/* ── Table Management ────────────────────────── */}
      <h2>Table Management</h2>
      <p>Requires a dashboard session, an account API token or the project&apos;s service key — never the anon key, because these routes run as the database owner and bypass row-level security.</p>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/api/projects/:projectId/tables</code></td><td>List tables</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/tables</code></td><td>Create table</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/tables/:name</code></td><td>Drop table</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/tables/:name/columns</code></td><td>List columns</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/tables/:name/columns</code></td><td>Add column</td></tr>
          <tr><td>PUT</td><td><code>/api/projects/:projectId/tables/:name/columns/:col</code></td><td>Edit column</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/tables/:name/columns/:col</code></td><td>Delete column</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/tables/:name/rows</code></td><td>Get rows</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/tables/:name/rows</code></td><td>Insert row</td></tr>
          <tr><td>PUT</td><td><code>/api/projects/:projectId/tables/:name/rows</code></td><td>Update row (body includes <code>pkWhere</code> + <code>data</code>)</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/tables/:name/rows</code></td><td>Delete row</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/tables/:name/foreign-keys</code></td><td>List FK</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/tables/:name/foreign-keys</code></td><td>Add FK</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/tables/:name/foreign-keys/:fk</code></td><td>Delete FK</td></tr>
        </tbody>
      </table></div>

      {/* ── Storage ─────────────────────────────────── */}
      <h2>Storage</h2>
      <p>S3-compatible file storage. Requires your API key or a session. The <a href="/docs/storage">Storage guide</a> lists every route.</p>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets</code></td><td>List buckets</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets</code></td><td>Create bucket</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/storage/buckets/:bucket</code></td><td>Delete bucket</td></tr>
          <tr><td>PATCH</td><td><code>/api/projects/:projectId/storage/buckets/:bucket</code></td><td>Toggle public</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects?prefix=</code></td><td>List objects</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects?path=</code></td><td>Upload (multipart)</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects/download?path=</code></td><td>Download object</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects/url?path=</code></td><td>Signed URL</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects</code></td><td>Delete objects</td></tr>
        </tbody>
      </table></div>

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
