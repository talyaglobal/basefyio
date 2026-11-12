import type { Metadata } from "next";
import { docsMetadata } from "../docs-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "JavaScript / TypeScript SDK (basefyio-js): createClient, database queries, auth, and storage from your app.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/sdk", "SDK Reference", pageDescription);
}

export default function SdkDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>JavaScript / TypeScript SDK</h1>
      <p>
        The basefyio SDK provides a type-safe client for interacting with your
        project&apos;s database, authentication, and storage from any JavaScript
        or TypeScript environment.
      </p>

      <h2>Installation</h2>
      <pre><code>{`npm install basefyio-js`}</code></pre>

      <h2>Initialization</h2>
      <pre><code>{`import { createClient } from 'basefyio-js'

// Reads BASEFYIO_PROJECT_ID, BASEFYIO_ANON_KEY and BASEFYIO_API_URL from the
// environment automatically — a .env (e.g. written by \`basefyio link\`) is enough.
const bf = createClient()

// Or pass them explicitly:
const bf2 = createClient({
  apiUrl: '${apiUrl}',
  projectId: 'your-project-id',
  apiKey: 'your-anon-key',
})`}</code></pre>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Environment variable</th><th>Maps to</th></tr>
        </thead>
        <tbody>
          <tr><td><code>BASEFYIO_PROJECT_ID</code></td><td><code>projectId</code></td></tr>
          <tr><td><code>BASEFYIO_ANON_KEY</code></td><td><code>apiKey</code></td></tr>
          <tr><td><code>BASEFYIO_API_URL</code></td><td><code>apiUrl</code></td></tr>
        </tbody>
      </table></div>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Option</th><th>Type</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>apiUrl</code></td><td>string</td><td>Base URL of the basefyio API</td></tr>
          <tr><td><code>projectId</code></td><td>string</td><td>Your project ID</td></tr>
          <tr><td><code>apiKey</code></td><td>string</td><td>Anon key (client-safe) or service key (server only)</td></tr>
          <tr><td><code>autoRefreshToken</code></td><td>boolean</td><td>Auto-refresh auth tokens (default: true)</td></tr>
          <tr><td><code>headers</code></td><td>object</td><td>Custom headers for every request</td></tr>
          <tr><td><code>auth</code></td><td>object</td><td><code>{`{ persistSession, storage, storageKey }`}</code> — keep the session across reloads (off by default; see Session Management)</td></tr>
        </tbody>
      </table></div>
      <p>
        In a browser there is no environment to read: pass <code>projectId</code> and
        <code>apiKey</code> explicitly, or <code>createClient()</code> throws
        &quot;Missing projectId&quot;. The SDK needs Node 18+ (global <code>fetch</code>) or any
        modern browser; the package exports <code>VERSION</code>.
      </p>

      <h3>Results and errors</h3>
      <p>
        Every call resolves to <code>{`{ data, error }`}</code> and never throws (realtime
        calls aside). <code>error</code> is <code>{`{ message, status?, code? }`}</code>:
        <code>status</code> is the HTTP status when the API answered; <code>code</code> is
        Postgres&apos; SQLSTATE for a database error (<code>23505</code> duplicate key,
        <code>42501</code> missing privilege), the API&apos;s own code otherwise
        (<code>PGRST116</code>, <code>mfa_required</code>), or <code>network_error</code> /
        <code>invalid_request</code> when the request did not get through or the SDK refused it
        before sending. Values come back as the database returns them:
        <code>bigint</code>, <code>numeric</code> and <code>count(*)</code> are
        <strong>strings</strong>, so no digit is lost; a <code>BigInt</code> you pass is sent
        as its decimal string.
      </p>

      {/* ── Database ────────────────────────────────── */}
      <h2>Database</h2>

      <h3>Query Builder</h3>
      <p>
        <code>bf.from(table)</code> returns a chainable query builder.
      </p>
      <pre><code>{`// Select all posts
const { data, error } = await bf.from('posts').select()

// Select specific columns with filters
const { data } = await bf.from('posts')
  .select('id, title, created_at')
  .eq('status', 'published')
  .order('created_at', { ascending: false })
  .limit(10)

// Insert
const { data } = await bf.from('posts')
  .insert({ title: 'Hello', body: 'World' })

// Update
const { data } = await bf.from('posts')
  .update({ title: 'Updated' })
  .eq('id', 1)

// Delete
const { error } = await bf.from('posts')
  .delete()
  .eq('id', 1)

// Upsert — onConflict names a unique column; without it, the primary key
const { data } = await bf.from('posts')
  .upsert({ id: 1, title: 'Upserted' }, { onConflict: 'id' })

// Exactly one row, as an object
const { data: post, error } = await bf.from('posts').select().eq('id', 1).single()

// Columns a write returns; aggregates, aliases and casts in select()
await bf.from('posts').insert({ title: 'Hello' }).select('id')
const { data: perStatus } = await bf.from('posts').select('status, count(*) as n')`}</code></pre>
      <ul>
        <li>
          <strong><code>update()</code> and <code>delete()</code> need a filter.</strong> Without
          one they would change or delete every row, so they return an error and send nothing.
          When that is the intent, say so: <code>{`update(patch, { allowFullTable: true })`}</code>,
          <code>{`delete({ allowFullTable: true })`}</code>.
        </li>
        <li>
          <strong><code>single()</code></strong> resolves to one object, and to an error
          (<code>PGRST116</code>) when no row or several rows match — on an update or delete a
          filter matching several rows changes nothing. <code>maybeSingle()</code> answers
          <code>null</code> for no row. Add <code>.limit(1)</code> to take the first of several.
        </li>
        <li>
          <strong><code>upsert()</code></strong> leaves a row that carries only its key as it is;
          <code>{`{ ignoreDuplicates: true }`}</code> keeps every existing row. It goes through the
          REST API under the same role and policies as <code>insert()</code>.
        </li>
        <li>
          A read without <code>limit()</code> returns at most 100 rows; <code>limit()</code> and
          <code>range()</code> go up to 1000.
        </li>
        <li>
          <strong>With the anon key</strong>, a write needs the table to allow it: a
          <code>GRANT</code> to the role and, with row-level security on, a policy for the
          operation — otherwise the error is &quot;permission denied for table …&quot;
          (<code>42501</code>). <code>listTables()</code>, <code>getColumns()</code> and bucket
          administration need the service key.
        </li>
      </ul>

      <h3>Filters</h3>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Method</th><th>SQL Equivalent</th><th>Example</th></tr>
        </thead>
        <tbody>
          <tr><td><code>.eq(col, val)</code></td><td><code>= val</code></td><td><code>.eq(&apos;status&apos;, &apos;active&apos;)</code></td></tr>
          <tr><td><code>.neq(col, val)</code></td><td><code>!= val</code></td><td><code>.neq(&apos;role&apos;, &apos;admin&apos;)</code></td></tr>
          <tr><td><code>.gt(col, val)</code></td><td><code>&gt; val</code></td><td><code>.gt(&apos;age&apos;, 18)</code></td></tr>
          <tr><td><code>.gte(col, val)</code></td><td><code>&gt;= val</code></td><td><code>.gte(&apos;score&apos;, 90)</code></td></tr>
          <tr><td><code>.lt(col, val)</code></td><td><code>&lt; val</code></td><td><code>.lt(&apos;price&apos;, 100)</code></td></tr>
          <tr><td><code>.lte(col, val)</code></td><td><code>&lt;= val</code></td><td><code>.lte(&apos;qty&apos;, 0)</code></td></tr>
          <tr><td><code>.like(col, pattern)</code></td><td><code>LIKE</code></td><td><code>.like(&apos;name&apos;, &apos;%john%&apos;)</code></td></tr>
          <tr><td><code>.ilike(col, pattern)</code></td><td><code>ILIKE</code></td><td><code>.ilike(&apos;name&apos;, &apos;%john%&apos;)</code></td></tr>
          <tr><td><code>.is(col, val)</code></td><td><code>IS</code></td><td><code>.is(&apos;deleted_at&apos;, null)</code></td></tr>
          <tr><td><code>.in(col, vals)</code></td><td><code>IN (...)</code></td><td><code>.in(&apos;id&apos;, [1,2,3])</code></td></tr>
          <tr><td><code>.not(col, op, val)</code></td><td><code>NOT</code></td><td><code>.not(&apos;status&apos;, &apos;eq&apos;, &apos;draft&apos;)</code></td></tr>
          <tr><td><code>.or(callback)</code></td><td><code>OR</code></td><td><code>.or(q =&gt; q.eq(&apos;status&apos;, &apos;active&apos;).eq(&apos;role&apos;, &apos;admin&apos;))</code></td></tr>
          <tr><td><code>.orRaw(sql)</code></td><td>raw SQL</td><td>Writes the string into the query <strong>unescaped</strong>. Never pass user input to it (SQL injection) — use <code>.or()</code></td></tr>
        </tbody>
      </table></div>

      <h3>Modifiers</h3>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Method</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>.order(col, opts?)</code></td><td>Sort results. <code>{`{ ascending: false }`}</code></td></tr>
          <tr><td><code>.limit(n)</code></td><td>Limit number of rows</td></tr>
          <tr><td><code>.offset(n)</code></td><td>Skip rows</td></tr>
          <tr><td><code>.range(from, to)</code></td><td>Pagination range</td></tr>
          <tr><td><code>.single()</code></td><td>Return one object; an error (<code>PGRST116</code>) unless exactly one row matches</td></tr>
          <tr><td><code>.maybeSingle()</code></td><td>Return one object or null; an error when several rows match</td></tr>
          <tr><td><code>.toSQL()</code></td><td>The statement with its values written in, for reading</td></tr>
          <tr><td><code>.toQuery()</code></td><td><code>{`{ text, params }`}</code> — the statement as it is sent</td></tr>
        </tbody>
      </table></div>

      <h3>Raw SQL</h3>
      <pre><code>{`// Pass values as the second argument, never inside the string
const { data, error } = await bf.sql('SELECT count(*) FROM users WHERE team_id = $1', [teamId])

const { data } = await bf.listTables()        // service key
const { data } = await bf.getColumns('posts') // service key`}</code></pre>

      <h3>Database functions (rpc)</h3>
      <pre><code>{`// POST /api/rest/v1/rpc/add_to_cart with the arguments by name
const { data, error } = await bf.rpc('add_to_cart', { product_id: 42, qty: 1 })`}</code></pre>
      <p>
        <code>rpc(fn, args)</code> calls a function in the <code>public</code> schema and
        resolves to <code>{`{ data, error }`}</code>; <code>data</code> is the rows it returned
        (a function returning one value gives one row keyed by its name). Earlier releases
        returned the rows directly and threw on failure — a successful result is still also
        that array, so old code keeps running, but read <code>data</code> in new code. A
        <code>SECURITY DEFINER</code> function needs a signed-in user or the service key.
      </p>

      {/* ── Auth ────────────────────────────────────── */}
      <h2>Authentication</h2>
      <p>
        All auth methods are under <code>bf.auth</code>.
      </p>

      <h3>Sign Up &amp; Sign In</h3>
      <pre><code>{`// Sign up
const { data, error } = await bf.auth.signUp({
  email: 'user@example.com',
  password: 'securepassword',
})

// Sign in
const { data, error } = await bf.auth.signIn({
  email: 'user@example.com',
  password: 'securepassword',
})

// Sign out — also revokes the refresh token on the server
const { error } = await bf.auth.signOut()`}</code></pre>

      <h3>Email Verification</h3>
      <pre><code>{`// User receives OTP via email after sign up
const { data, error } = await bf.auth.verifyEmail('123456')`}</code></pre>

      <h3>Password Reset</h3>
      <pre><code>{`// Request reset
await bf.auth.forgotPassword('user@example.com')

// Reset with OTP
await bf.auth.resetPassword('123456', 'newpassword')`}</code></pre>

      <h3>Magic Link</h3>
      <pre><code>{`// Send magic link
await bf.auth.sendMagicLink('user@example.com')

// Verify (from email link)
const { data } = await bf.auth.verifyMagicLink('otp-from-url')`}</code></pre>

      <h3>OAuth</h3>
      <pre><code>{`// In a browser this navigates to Google itself
await bf.auth.signInWithProvider('google', {
  redirectTo: 'https://myapp.com/auth/callback',
})

// To redirect yourself (or outside a browser), take the URL instead
const { data } = await bf.auth.signInWithProvider('google', {
  redirectTo: 'https://myapp.com/auth/callback',
  skipBrowserRedirect: true,
})
// data.url → send the user there

// On the callback page — synchronous: the tokens, or null
const tokens = bf.auth.handleProviderCallback()`}</code></pre>

      <h3>Session Management</h3>
      <pre><code>{`const { data: user, error } = await bf.auth.getUser() // error.status 401 when signed out
const session = bf.auth.getSession()
const token = bf.auth.getAccessToken()

// Listen to auth changes
bf.auth.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED'
  //      | 'EMAIL_VERIFIED' | 'EMAIL_CHANGED' | 'INITIAL_SESSION'
})

// Keep the session across reloads (localStorage by default)
const bf = createClient({ projectId, apiKey, auth: { persistSession: true } })
await bf.auth.ready() // the stored session is restored`}</code></pre>
      <p>
        The session is kept in memory unless <code>persistSession</code> is on. Stored tokens
        are readable by every script on the page, so enable it only where that is acceptable.
      </p>

      <h3>Other Auth Methods</h3>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Method</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>changeEmail(newEmail)</code></td><td>Request email change</td></tr>
          <tr><td><code>confirmChangeEmail(otp)</code></td><td>Confirm with OTP</td></tr>
          <tr><td><code>requestReauth()</code></td><td>Request re-authentication OTP</td></tr>
          <tr><td><code>verifyReauth(otp)</code></td><td>Verify re-auth</td></tr>
          <tr><td><code>inviteUser(email)</code></td><td>Invite user (service key only)</td></tr>
          <tr><td><code>refreshSession()</code></td><td>Manually refresh tokens</td></tr>
          <tr><td><code>setAccessToken(token)</code></td><td>Set token manually</td></tr>
        </tbody>
      </table></div>

      {/* ── Storage ─────────────────────────────────── */}
      <h2>Storage</h2>
      <p>
        S3-compatible file storage via <code>bf.storage</code>.
      </p>

      <h3>Bucket Management</h3>
      <pre><code>{`// List buckets
const { data } = await bf.storage.listBuckets()

// Create bucket
await bf.storage.createBucket('avatars', { public: true })

// Delete bucket (409 while it holds files; force deletes them with it)
await bf.storage.deleteBucket('avatars', { force: true })

// Update bucket
await bf.storage.updateBucket('avatars', { public: false })`}</code></pre>

      <h3>File Operations</h3>
      <pre><code>{`const bucket = bf.storage.from('avatars')

// Upload
const { data, error } = await bucket.upload(
  'user-123/photo.jpg',
  file,
  { contentType: 'image/jpeg' }
)

// Download
const { data } = await bucket.download('user-123/photo.jpg')

// List files
const { data } = await bucket.list('user-123/')

// Signed URL (temporary access)
const { data } = await bucket.createSignedUrl('user-123/photo.jpg', 3600) // seconds, or { expiresIn: 3600 }
// data.url, data.expiresIn

// Public URL (for public buckets)
const url = bucket.getPublicUrl('user-123/photo.jpg') // a string; works in <img src> without a key

// Delete
await bucket.remove(['user-123/photo.jpg', 'user-123/old.jpg'])`}</code></pre>

      {/* ── Collections, Data Engine, Realtime ──────── */}
      <h2>Collections</h2>
      <p>
        Document collections via <code>bf.collection(name)</code>; creating, listing and
        dropping collections (<code>bf.collections</code>) needs the service key.
      </p>
      <pre><code>{`const posts = bf.collection('posts')
await posts.insert({ title: 'Hello', status: 'draft' })
const { data } = await posts.find({ status: 'published', views: { $gte: 100 } }).sort('views', 'desc').limit(10)
await posts.updateById(id, { views: 42 })
await posts.deleteById(id)`}</code></pre>

      <h2>Data Engine</h2>
      <p>
        Entities via <code>bf.data.entity(name)</code> (service key). See{' '}
        <a href="/docs/data-engine">Data Engine</a>.
      </p>
      <pre><code>{`const orders = bf.data.entity('orders')
await orders.insert({ total: 12.5 })
const { data: page } = await orders.find({ status: 'open' }).sort('createdAt', 'desc').limit(20)`}</code></pre>

      <h2>Realtime</h2>
      <p>
        Table and collection changes, presence and broadcast via <code>bf.realtime</code> — see{' '}
        <a href="/docs/realtime">Realtime</a>. In Node, realtime without a signed-in user
        needs <code>EventSource</code> (global from Node 22; assign a polyfill to
        <code>globalThis.EventSource</code> on older versions).
      </p>
    </div>
  );
}
