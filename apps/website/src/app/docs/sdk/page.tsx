import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "JavaScript / TypeScript SDK (basefyio-js): createClient, database queries, auth, and storage from your app.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/sdk", {
    title: "SDK Reference",
    description: pageDescription,
    openGraph: {
      title: "SDK Reference | basefyio Docs",
      description: pageDescription,
    },
  });
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

const bf = createClient({
  apiUrl: '${apiUrl}',
  projectId: 'your-project-id',
  apiKey: 'your-anon-key',
})`}</code></pre>
      <table>
        <thead>
          <tr><th>Option</th><th>Type</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>apiUrl</code></td><td>string</td><td>Base URL of the basefyio API</td></tr>
          <tr><td><code>projectId</code></td><td>string</td><td>Your project ID</td></tr>
          <tr><td><code>apiKey</code></td><td>string</td><td>Anon key (client-safe) or service key (server only)</td></tr>
          <tr><td><code>autoRefreshToken</code></td><td>boolean</td><td>Auto-refresh auth tokens (default: true)</td></tr>
          <tr><td><code>headers</code></td><td>object</td><td>Custom headers for every request</td></tr>
        </tbody>
      </table>

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

// Upsert
const { data } = await bf.from('posts')
  .upsert({ id: 1, title: 'Upserted' }, { onConflict: 'id' })`}</code></pre>

      <h3>Filters</h3>
      <table>
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
        </tbody>
      </table>

      <h3>Modifiers</h3>
      <table>
        <thead>
          <tr><th>Method</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>.order(col, opts?)</code></td><td>Sort results. <code>{`{ ascending: false }`}</code></td></tr>
          <tr><td><code>.limit(n)</code></td><td>Limit number of rows</td></tr>
          <tr><td><code>.offset(n)</code></td><td>Skip rows</td></tr>
          <tr><td><code>.range(from, to)</code></td><td>Pagination range</td></tr>
          <tr><td><code>.single()</code></td><td>Return single object (error if not exactly one)</td></tr>
          <tr><td><code>.maybeSingle()</code></td><td>Return single object or null</td></tr>
        </tbody>
      </table>

      <h3>Raw SQL</h3>
      <pre><code>{`const { data, error } = await bf.sql('SELECT COUNT(*) FROM users')

const { data } = await bf.listTables()
const { data } = await bf.getColumns('posts')`}</code></pre>

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

// Sign out
await bf.auth.signOut()`}</code></pre>

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
      <pre><code>{`// Redirect to Google
const { data } = await bf.auth.signInWithProvider('google', {
  redirectTo: 'https://myapp.com/auth/callback',
})
// data.url → redirect user to this URL

// On callback page
const { data, error } = await bf.auth.handleProviderCallback()`}</code></pre>

      <h3>Session Management</h3>
      <pre><code>{`const user = await bf.auth.getUser()
const session = await bf.auth.getSession()
const token = bf.auth.getAccessToken()

// Listen to auth changes
bf.auth.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED'
})`}</code></pre>

      <h3>Other Auth Methods</h3>
      <table>
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
      </table>

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

// Delete bucket
await bf.storage.deleteBucket('avatars')

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
const { data } = await bucket.createSignedUrl('user-123/photo.jpg', {
  expiresIn: 3600 // seconds
})

// Public URL (for public buckets)
const { data } = bucket.getPublicUrl('user-123/photo.jpg')

// Delete
await bucket.remove(['user-123/photo.jpg', 'user-123/old.jpg'])`}</code></pre>
    </div>
  );
}
