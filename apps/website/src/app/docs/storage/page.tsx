import type { Metadata } from "next";
import { docsMetadata } from "../docs-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio Storage: S3-compatible file storage with public/private buckets, folders, uploads, downloads, signed URLs, and public links — via the SDK or REST API.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/storage", "Storage", pageDescription);
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
      <div className="docs-table"><table>
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
      </table></div>

      {/* ── Buckets ─────────────────────────────────── */}
      <h2>Buckets</h2>
      <p>Manage buckets with <code>bf.storage</code>.</p>
      <pre><code>{`import { createClient } from 'basefyio-js'
const bf = createClient()

// Create a bucket (private by default)
await bf.storage.createBucket('avatars')

// Create a PUBLIC bucket
await bf.storage.createBucket('assets', { public: true })

// Optional upload limits, enforced on every upload to the bucket
await bf.storage.createBucket('photos', { fileSizeLimit: 50 * 1024 * 1024, allowedMimeTypes: ['image/*'] })

// List all buckets
const { data: buckets } = await bf.storage.listBuckets()
// [{ name, public, objectCount, totalSize, createdAt, fileSizeLimit, allowedMimeTypes }]

// Change visibility (public ↔ private) or limits
await bf.storage.updateBucket('avatars', { public: true })
await bf.storage.updateBucket('photos', { fileSizeLimit: null })   // back to the platform ceiling

// Delete a bucket: refused (409) while it holds files…
await bf.storage.deleteBucket('avatars')
// …unless you say so: deletes the bucket with everything in it
await bf.storage.deleteBucket('avatars', { force: true })`}</code></pre>
      <p className="text-sm">
        Bucket names are 3–63 characters of lowercase letters, numbers and hyphens, and can&apos;t
        start or end with a hyphen. Anything else is refused with a 400 — a name is never rewritten.
        Creating, changing and deleting buckets needs the service key (your server) or the dashboard.
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

// Uploading to the same path overwrites the existing object.

// Large files: chunked and resumable
await bucket.uploadResumable('talks/keynote.mp4', bigFile, {
  onProgress: ({ percent }) => console.log(percent),
})`}</code></pre>
      <blockquote>
        One upload request carries up to 500&nbsp;MB per file (the operator&apos;s{" "}
        <code>STORAGE_MAX_UPLOAD_MB</code>; <code>GET /storage/limits</code> reports the value in
        force). Larger files go through <code>uploadResumable()</code> (up to 5&nbsp;GB). A
        bucket&apos;s own <code>fileSizeLimit</code> and <code>allowedMimeTypes</code> apply on top:
        a larger file is refused with 413, another type with 415.
      </blockquote>

      {/* ── List ────────────────────────────────────── */}
      <h2>Listing files &amp; folders</h2>
      <pre><code>{`// List the bucket root
const { data } = await bf.storage.from('avatars').list()

// List inside a folder (prefix)
const { data } = await bf.storage.from('avatars').list('user-123/')
// A file:   { name: 'user-123/a.png', size, lastModified, etag }
// A folder: { prefix: 'user-123/2026/', name: '', size: 0 }  — check "prefix" to tell them apart

// Search, sort and page (folders stay ahead of files)
const { data: page } = await bf.storage.from('avatars').list('user-123/', {
  search: 'invoice', sortBy: 'lastModified', order: 'desc', limit: 50, offset: 0,
})

// Everything below a folder, at any depth
await bf.storage.from('avatars').list('user-123/', { recursive: true })`}</code></pre>

      {/* ── Download ─────────────────────────────────── */}
      <h2>Downloading files</h2>
      <pre><code>{`// Download as a Blob
const { data: blob } = await bf.storage.from('avatars').download('user-123/avatar.png')

// Delete one or more files (a path ending in "/" deletes a whole folder)
const { data } = await bf.storage.from('avatars').remove([
  'user-123/avatar.png',
  'user-123/old.png',
])
// data: { message, deleted: [...keys removed], notFound: [...paths that were not there] }

// Copy and rename (files, or folders with both paths ending in "/")
await bf.storage.from('avatars').copy('user-123/avatar.png', 'user-123/avatar-backup.png')
await bf.storage.from('avatars').move('user-123/old.png', 'archive/old.png')
// An existing destination is refused (409) unless { overwrite: true }`}</code></pre>

      {/* ── Public vs signed ─────────────────────────── */}
      <h2>Public links &amp; signed URLs</h2>
      <p>
        <strong>Public bucket</strong> — anyone can read a file whose path they know, no token
        needed. <code>getPublicUrl()</code> builds such a link locally (no request) that works in{" "}
        <code>&lt;img src&gt;</code>, <code>&lt;video src&gt;</code> and plain links:
      </p>
      <pre><code>{`const url = bf.storage.from('assets').getPublicUrl('logos/brand.png')   // a string
// → ${apiUrl}/api/projects/<projectId>/storage/public/assets?path=logos%2Fbrand.png

// The permanent address on the storage host, asked from the API
const { data } = await bf.storage.from('assets').fetchPublicUrl('logos/brand.png')
// data.publicUrl → https://${storageHost}/<internal-bucket>/logos/brand.png  (null for a private bucket)`}</code></pre>
      <p>
        <strong>Private bucket</strong> — reached by signed-in users of your app (the SDK sends
        their token), by your server with the service key, or through a{" "}
        <strong>time-limited signed URL</strong>. The public anon key on its own is refused (403):
        it ships inside every browser app, so a bucket it could open would not be private.
      </p>
      <pre><code>{`// Temporary signed URL for a private object (default 1 hour, min 60 s, max 7 days)
const { data } = await bf.storage.from('reports').createSignedUrl('q1/summary.pdf', 600)
// or: createSignedUrl('q1/summary.pdf', { expiresIn: 600 })
// data.url  data.expiresIn — a missing file answers 404 instead of a dead link`}</code></pre>
      <blockquote>
        A public bucket hands out files, not an index: its base URL does not list what is
        inside. Web pages, SVG and XML files are served as downloads rather than rendered, so a
        file in a bucket can never pose as a page on the shared storage host. To let the anon
        key read a private bucket or folder on purpose, give it a <code>public-read</code> access
        rule from your server: <code>{"bf.storage.setBucketPolicy(bucket, { mode: 'public-read' })"}</code>.
      </blockquote>

      {/* ── Dashboard ───────────────────────────────── */}
      <h2>In the dashboard</h2>
      <p>The <strong>Storage</strong> tab adds workflows beyond the SDK:</p>
      <ul>
        <li><strong>New folder</strong> — create an empty folder in the current location.</li>
        <li><strong>Upload folder</strong> — upload a whole local folder, preserving its
          structure; if files already exist you&apos;re asked to overwrite or skip them.</li>
        <li><strong>Search, sort, grid or list view, and previews</strong> of images, PDFs and text files.</li>
        <li><strong>Rename</strong> files and folders, and <strong>overwrite, keep both or skip</strong> when an upload meets a file of the same name.</li>
        <li><strong>Links you can share</strong> — the open bucket and folder are part of the page address, so the back button and bookmarks work.</li>
        <li><strong>Public link</strong> — copy a shareable URL for a public file.</li>
        <li>Make a bucket <strong>public</strong> (with a confirmation) or <strong>private</strong>, and set its upload limits (largest file, allowed types).</li>
      </ul>

      {/* ── REST ────────────────────────────────────── */}
      <h2>REST API</h2>
      <p>All routes are relative to <code>{apiUrl}</code> and require your API key or a session.</p>
      <div className="docs-table"><table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets</code></td><td>List buckets</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets</code></td><td>Create bucket <code>{`{ name, public?, fileSizeLimit?, allowedMimeTypes? }`}</code></td></tr>
          <tr><td>PATCH</td><td><code>/api/projects/:projectId/storage/buckets/:bucket</code></td><td>Change visibility and/or limits <code>{`{ public?, fileSizeLimit?, allowedMimeTypes? }`}</code></td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/storage/buckets/:bucket</code></td><td>Delete bucket; 409 while it holds files unless <code>?force=true</code></td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/limits</code></td><td>Upload ceiling and signed URL bounds</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/public/:bucket?path=</code></td><td>A public bucket&apos;s file, no key needed</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/public-url?path=</code></td><td>Public URL (public buckets)</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/folders</code></td><td>Create folder <code>{`{ path }`}</code></td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects?prefix=</code></td><td>List objects/folders; optional <code>recursive</code>, <code>search</code>, <code>sortBy</code>, <code>order</code>, <code>limit</code>, <code>offset</code></td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects?path=</code></td><td>Upload (multipart <code>file</code>)</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects/exists</code></td><td>Which of <code>{`{ paths }`}</code> exist</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects/copy</code></td><td>Copy <code>{`{ from, to, overwrite? }`}</code></td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects/rename</code></td><td>Rename <code>{`{ from, to, overwrite? }`}</code></td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects/move</code></td><td>Move into a folder <code>{`{ sources, destFolder }`}</code></td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects/download?path=</code></td><td>Download a file</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects/url?path=&amp;expiry=</code></td><td>Signed URL</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/storage/buckets/:bucket/objects</code></td><td>Delete <code>{`{ paths }`}</code> → <code>{`{ message, deleted, notFound }`}</code></td></tr>
        </tbody>
      </table></div>
    </div>
  );
}
