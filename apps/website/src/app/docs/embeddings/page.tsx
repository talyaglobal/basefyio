import type { Metadata } from "next";
import Link from "next/link";
import { docsMetadata } from "../docs-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "Store text as vectors in your basefyio project database, search it semantically, and index files from your storage buckets for retrieval.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/embeddings", "AI & Embeddings", pageDescription);
}

export default function EmbeddingsDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>AI &amp; Embeddings</h1>
      <p>
        Every project can keep <strong>vector embeddings</strong> in its own database (pgvector)
        and search them by meaning rather than by exact words. You send text; basefyio has it
        embedded by the project&apos;s embedding provider and stores the vector next to your
        metadata. On top of that, <strong>retrieval</strong> indexes documents that already live in
        your storage buckets, so an assistant or search box can cite them.
      </p>

      <h2>1. Turn it on</h2>
      <p>
        Open the project&apos;s <strong>AI / Embeddings</strong> page and choose{" "}
        <strong>Enable</strong>. That installs the vector extension and the embedding tables in
        the project database. The same page lets you pick the embedding provider and model for
        this project, add your own provider key, and shows exactly where your text is sent.
      </p>

      <h2>2. Store text</h2>
      <p>
        Writes need the <strong>service key</strong> — call them from your server.
      </p>
      <pre><code>{`curl -X POST "${apiUrl}/api/rest/v1/embeddings" \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{ "content": "Reset your password from Settings → Security.", "namespace": "help", "metadata": { "source": "faq" } }'

# Many at once
curl -X POST "${apiUrl}/api/rest/v1/embeddings/batch" \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{ "items": [ { "content": "…", "namespace": "help" }, { "content": "…", "namespace": "help" } ] }'`}</code></pre>
      <p>
        Storing the same text in the same namespace again returns the existing record instead of
        a second vector.
      </p>

      <h2>3. Search</h2>
      <p>
        Search takes the anon key together with a signed-in user&apos;s token, or the service key:
      </p>
      <pre><code>{`curl -X POST "${apiUrl}/api/rest/v1/embeddings/search" \\
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "query": "how do I change my password", "namespace": "help", "limit": 5 }'`}</code></pre>
      <pre><code>{`[ { "id": "…", "namespace": "help", "content": "Reset your password from …",
    "metadata": { "source": "faq" }, "distance": 0.18, "score": 0.82 } ]`}</code></pre>
      <p>
        <code>threshold</code> is the largest cosine distance to accept (default 0.5),{" "}
        <code>limit</code> defaults to 10, and <code>filter</code> matches <code>metadata</code>{" "}
        keys exactly.
      </p>

      <h2>Routes</h2>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Key</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>POST</td><td><code>/api/rest/v1/embeddings</code></td><td>service</td><td>Embed and store one text</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/embeddings/batch</code></td><td>service</td><td>Embed and store many texts</td></tr>
          <tr><td>POST</td><td><code>/api/rest/v1/embeddings/search</code></td><td>anon + user, or service</td><td>Semantic search</td></tr>
          <tr><td>DELETE</td><td><code>/api/rest/v1/embeddings</code></td><td>service</td><td>Delete by ids: <code>{`{ "ids": [...] }`}</code></td></tr>
          <tr><td>DELETE</td><td><code>/api/rest/v1/embeddings/namespace</code></td><td>service</td><td>Delete a namespace: <code>{`{ "namespace": "help" }`}</code></td></tr>
          <tr><td>GET</td><td><code>/api/rest/v1/embeddings/status</code></td><td>anon</td><td>Whether vectors are enabled and how many are stored</td></tr>
          <tr><td>GET</td><td><code>/api/rest/v1/embeddings/disclosure</code></td><td>anon</td><td>Provider, model, vector width, country and retention</td></tr>
        </tbody>
      </table></div>

      <h2>Where your text goes</h2>
      <p>
        Embedding means sending text to a model. The disclosure route — and the dashboard page —
        name the provider and model in use, the country the text is processed in and the
        provider&apos;s retention statement, so you can show the same facts to your own users.
        Vectors are stored at a fixed width of 1536 dimensions; switching a project to another
        model re-embeds what is already stored.
      </p>

      <h2>Retrieval over your files</h2>
      <p>
        Retrieval works on files that are already in one of the project&apos;s{" "}
        <Link href="/docs/storage">storage buckets</Link>. Register a file, and basefyio splits it
        into chunks, embeds them in the background and makes them searchable. Every hit names
        the bucket and object it came from. These routes search the whole corpus, so they take
        the service key or a dashboard session.
      </p>
      <pre><code>{`# Register a file that is already in the "handbooks" bucket
curl -X POST "${apiUrl}/api/projects/$PROJECT_ID/rag/documents" \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{ "bucketName": "handbooks", "objectKey": "hr/leave-policy.pdf", "title": "Leave policy" }'

# Search it
curl "${apiUrl}/api/projects/$PROJECT_ID/rag/search?q=how+many+days+of+leave&limit=5" \\
  -H "apikey: $SERVICE_KEY"`}</code></pre>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>POST</td><td><code>/api/projects/:projectId/rag/documents</code></td><td>Register a stored file and queue its indexing</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/rag/documents</code></td><td>List documents and their status</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/rag/index/status</code></td><td>Document counts per status</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/rag/index/reindex</code></td><td>Re-index one document or the whole project</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/rag/index/reindex-incomplete</code></td><td>Queue every document that is not indexed yet</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/rag/search</code></td><td><code>?q=…&amp;limit=8&amp;threshold=0.45</code></td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/rag/usage</code></td><td>Embedding usage of this project&apos;s corpus</td></tr>
        </tbody>
      </table></div>
      <p>
        Documents move from <code>PENDING</code> to <code>PROCESSING</code> to{" "}
        <code>INDEXED</code> (or <code>FAILED</code>); a document whose file changed becomes{" "}
        <code>STALE</code> until it is re-indexed.
      </p>
    </div>
  );
}
