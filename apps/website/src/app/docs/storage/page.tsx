import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio Storage: S3-compatible file storage with public/private buckets, folders, uploads, downloads, signed URLs, and public links — via the SDK or REST API.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/storage", {
    title: "Storage",
    description: pageDescription,
    openGraph: {
      title: "Storage | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function StorageDocs() {
  const apiUrl = getPublicApiUrl();
  const storageHost = "storage.basefyio.com";

  return (
    <div>
      <h1>Storage</h1>
      <p>
        Every project gets <strong>S3-compatible object storage</strong>. You organize files
        into <strong>buckets</strong>, and each bucket can be <strong>private</strong> (access
        through your app / signed URLs) or <strong>public</strong> (files served directly over a
        permanent URL). Use it for avatars, uploads, exports, static assets, and more.
      </p>

      <h2>Concepts</h2>
      <table>
        <thead>
          <tr><th>Term</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Bucket</strong></td><td>A top-level container for files. Created public or private.</td></tr>
          <tr><td><strong>Object</strong></td><td>A single file, addressed by its path (e.g. <code>user-123/avatar.png</code>).</td></tr>
          <tr><td><strong>Folder</strong></td><td>A path prefix. There are no real directories — a <code>/</code> in the path groups files. <code>avatars/2026/pic.png</code> lives in the <code>avatars/2026/</code> folder.</td></tr>
          <tr><td><strong>Public bucket</strong></td><td>Objects are readable by anyone at a permanent URL, no token. Good for assets.</td></tr>
          <tr><td><strong>Private bucket</strong></td><td>Objects require your app&apos;s session or a time-limited <em>signed URL</em>.</td></tr>
        </tbody>
      </table>

      {/* ── Buckets ─────────────────────────────────── */}
      <h2>Buckets</h2>
      <p>Manage buckets with <code>bf.storage</code>.</p>
      <pre><code>{`import { createClient } from 'basefyio-js'
const bf = createClient()

// Create a bucket (private by default)
await bf.storage.createBucket('avatars')

// Create a PUBLIC bucket
await bf.storage.createBucket('assets', { public: true })

// List all buckets
const { data: buckets } = await bf.storage.listBuckets()
// [{ name, public, objectCount, totalSize, createdAt }]

// Change visibility (public ↔ private)
await bf.storage.updateBucket('avatars', { public: true })

// Delete a bucket (must be empty)
await bf.storage.deleteBucket('avatars')`}</code></pre>
      <p className="text-sm">
        Bucket names are 3–63 characters, lowercase letters, numbers and hyphens, and can&apos;t
        start or end with a hyphen.
      </p>

      {/* ── Upload ──────────────────────────────────── */}
      <h2>Uploading files</h2>
      <p>
        Scope operations to a bucket with <code>bf.storage.from(bucket)</code>. The path may
        include <code>/</code> to place the file in a folder — parent folders are created
        implicitly.
      </p>
      <pre><code>{`const bucket = bf.storage.from('avatars')

// Upload (browser File/Blob, Uint8Array or ArrayBuffer)
const { data, error } = await bucket.upload(
  'user-123/avatar.png',   // path — the "user-123/" folder is implied
  file,
  { contentType: 'image/png' }
)

// Uploading to the same path overwrites the existing object.`}</code></pre>
      <blockquote>
        Max upload size is 50&nbsp;MB per file via the API. For folders, see the dashboard&apos;s
        <strong> Upload folder</strong> action below.
      </blockquote>

      {/* ── List ────────────────────────────────────── */}
      <h2>Listing files &amp; folders</h2>
      <pre><code>{`// List the bucket root
const { data } = await bf.storage.from('avatars').list()

// List inside a folder (prefix)
const { data } = await bf.storage.from('avatars').list('user-123/')
// Entries with a "prefix" field are folders; entries with "name" are files:
// { name, size, lastModified, etag }  |  { prefix: 'user-123/' }`}</code></pre>

      {/* ── Download ─────────────────────────────────── */}
      <h2>Downloading files</h2>
      <pre><code>{`// Download as a Blob
const { data: blob } = await bf.storage.from('avatars').download('user-123/avatar.png')

// Delete one or more files
await bf.storage.from('avatars').remove([
  'user-123/avatar.png',
  'user-123/old.png',
])`}</code></pre>

      {/* ── Public vs signed ─────────────────────────── */}
      <h2>Public links &amp; signed URLs</h2>
      <p>
        <strong>Public bucket</strong> — objects are served directly, no token, at a permanent URL:
      </p>
      <pre><code>{`https://${storageHost}/<internal-bucket>/<path>`}</code></pre>
      <p>
        From the dashboard (<strong>Storage</strong> tab) you can copy the public link for the
        whole bucket, any folder, or an individual file — and toggle a bucket public/private.
        For a private bucket, generate a <strong>time-limited signed URL</strong> instead:
      </p>
      <pre><code>{`// Temporary signed URL for a private object (default 1 hour, max 7 days)
const { data } = await bf.storage.from('reports').createSignedUrl(
  'q1/summary.pdf',
  { expiresIn: 3600 }   // seconds
)
// data.url  data.expiresIn`}</code></pre>
      <blockquote>
        A folder/bucket public link is the <em>base URL</em> for its objects — appending a file
        path yields a working link. Object storage has no anonymous directory listing, so the
        base URL alone won&apos;t list contents.
      </blockquote>

      {/* ── Dashboard ───────────────────────────────── */}
      <h2>In the dashboard</h2>
      <p>The <strong>Storage</strong> tab adds workflows beyond the SDK:</p>
      <ul>
        <li><strong>New folder</strong> — create an empty folder in the current location.</li>
        <li><strong>Upload folder</strong> — upload a whole local folder, preserving its
          structure; if files already exist you&apos;re asked to overwrite or skip them.</li>
        <li><strong>Public link</strong> — copy a shareable URL for a public bucket, folder, or file.</li>
        <li>Toggle a bucket between <strong>public</strong> and <strong>private</strong>.</li>
      </ul>

      {/* ── REST ────────────────────────────────────── */}
      <h2>REST API</h2>
      <p>All routes are under <code>{`${apiUrl}/api/projects/:projectId/storage`}</code> and require your API key / session.</p>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/buckets</code></td><td>List buckets</td></tr>
          <tr><td>POST</td><td><code>/buckets</code></td><td>Create bucket <code>{`{ name, public }`}</code></td></tr>
          <tr><td>PATCH</td><td><code>/buckets/:bucket</code></td><td>Set visibility <code>{`{ public }`}</code></td></tr>
          <tr><td>DELETE</td><td><code>/buckets/:bucket</code></td><td>Delete bucket</td></tr>
          <tr><td>GET</td><td><code>/buckets/:bucket/public-url?path=</code></td><td>Public URL (public buckets)</td></tr>
          <tr><td>POST</td><td><code>/buckets/:bucket/folders</code></td><td>Create folder <code>{`{ path }`}</code></td></tr>
          <tr><td>GET</td><td><code>/buckets/:bucket/objects?prefix=</code></td><td>List objects/folders</td></tr>
          <tr><td>POST</td><td><code>/buckets/:bucket/objects?path=</code></td><td>Upload (multipart <code>file</code>)</td></tr>
          <tr><td>POST</td><td><code>/buckets/:bucket/objects/exists</code></td><td>Which of <code>{`{ paths }`}</code> exist</td></tr>
          <tr><td>GET</td><td><code>/buckets/:bucket/objects/download?path=</code></td><td>Download a file</td></tr>
          <tr><td>GET</td><td><code>/buckets/:bucket/objects/url?path=&amp;expiry=</code></td><td>Signed URL</td></tr>
          <tr><td>DELETE</td><td><code>/buckets/:bucket/objects</code></td><td>Delete <code>{`{ paths }`}</code></td></tr>
        </tbody>
      </table>
    </div>
  );
}
