import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio AI: store text as vectors in your project's own database (pgvector), search it semantically, and run retrieval over documents in your storage buckets — via the dashboard or REST API.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/ai", {
    title: "AI / Embeddings",
    description: pageDescription,
    openGraph: {
      title: "AI / Embeddings | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function AiDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>AI / Embeddings</h1>
      <p>
        Store text as <strong>vectors</strong> in your project&apos;s own database (pgvector) and
        search it by meaning instead of keywords. Vectors are produced by an{" "}
        <strong>embedding provider</strong> — OpenAI by default, or Ollama (self-hosted) or Cohere
        — chosen for the platform and overridable per project. On top of that, <strong>retrieval</strong>{" "}
        indexes files that already live in your storage buckets so an application can search and
        cite them.
      </p>

      <h2>In the dashboard</h2>
      <p>Open your project and choose <strong>AI / Embeddings</strong>.</p>
      <ul>
        <li><strong>Vector Search (pgvector)</strong> — enable it to create the pgvector extension and the embedding tables in your project database. Disabling keeps the tables.</li>
        <li><strong>Embedding provider</strong> — pick the provider and model for this project. Switching model can re-embed your existing vectors.</li>
        <li><strong>API key</strong> — use a per-project key for the selected provider instead of the platform&apos;s.</li>
        <li><strong>Where your data goes</strong> — the provider, model, country the text is sent to and the provider&apos;s retention statement. Your application can show the same information to its own users.</li>
        <li><strong>API Reference</strong> — endpoints, your keys and a quick start, ready to copy.</li>
      </ul>

      <h2>Store and search text</h2>
      <p>
        Public routes live under <code>{`${apiUrl}/api/rest/v1/embeddings`}</code> and take your
        key in the <code>apikey</code> header. Writes need the <strong>service key</strong>; search
        needs the anon key together with a signed-in user&apos;s token (or the service key).
      </p>
      <pre><code>{`API=${apiUrl}/api/rest/v1

# Store one text (embedded once per content + namespace)
curl -s -X POST $API/embeddings \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{"content":"To reset your password, open Settings > Security.","namespace":"docs","metadata":{"source":"faq"}}'

# Search by meaning
curl -s -X POST $API/embeddings/search \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{"query":"how do I reset my password","namespace":"docs","limit":10,"threshold":0.5}'
# [{ id, namespace, content, metadata, distance, score }]`}</code></pre>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Key</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>POST</td><td><code>/embeddings</code></td><td>service</td><td>Embed and store one text <code>{`{ content, namespace?, metadata? }`}</code></td></tr>
          <tr><td>POST</td><td><code>/embeddings/batch</code></td><td>service</td><td>Embed and store many <code>{`{ items: [...] }`}</code></td></tr>
          <tr><td>POST</td><td><code>/embeddings/search</code></td><td>anon + user</td><td>Semantic search <code>{`{ query, namespace?, threshold?, limit?, filter? }`}</code></td></tr>
          <tr><td>DELETE</td><td><code>/embeddings</code></td><td>service</td><td>Delete by <code>{`{ ids }`}</code></td></tr>
          <tr><td>DELETE</td><td><code>/embeddings/namespace</code></td><td>service</td><td>Delete a whole <code>{`{ namespace }`}</code></td></tr>
          <tr><td>GET</td><td><code>/embeddings/status</code></td><td>anon</td><td>Whether pgvector is enabled and how many vectors exist</td></tr>
          <tr><td>GET</td><td><code>/embeddings/disclosure</code></td><td>anon</td><td>Provider, model, vector width, country, retention</td></tr>
        </tbody>
      </table>
      <p className="text-sm">
        <code>threshold</code> is the maximum cosine distance (default 0.5), <code>limit</code>{" "}
        defaults to 10 and is capped, and <code>filter</code> matches <code>metadata</code> keys
        exactly. Storing the same text in the same namespace again returns the existing record.
      </p>

      <h2>Retrieval over your documents</h2>
      <p>
        Register files that are already in a storage bucket; they are chunked and embedded in the
        background, and you search the whole corpus. Because the vector store has no row-level
        policy, these routes need the <strong>service key</strong> or a dashboard session, and
        indexing and searching are metered against the embedding budget.
      </p>
      <pre><code>{`API=${apiUrl}/api

# Register a storage object (it must already exist in the bucket)
curl -s -X POST $API/projects/$PROJECT_ID/rag/documents \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{"bucketName":"handbooks","objectKey":"hr/leave-policy.pdf","title":"Leave policy"}'

# Search — each hit names its source so you can cite it
curl -s "$API/projects/$PROJECT_ID/rag/search?q=how+many+days+of+leave&limit=5" \\
  -H "apikey: $SERVICE_KEY"
# [{ documentId, chunkIndex, title, text, score, distance, bucketName, objectKey }]`}</code></pre>
      <p>
        Routes under <code>{`${apiUrl}/api/projects/:projectId/rag`}</code>:
      </p>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>POST</td><td><code>/documents</code></td><td>Register a storage object <code>{`{ bucketName, objectKey, title?, granularity?, chunkSize?, chunkOverlap? }`}</code> and queue indexing</td></tr>
          <tr><td>GET</td><td><code>/documents</code></td><td>List documents (<code>status</code>, <code>limit</code> 1–100, <code>offset</code>)</td></tr>
          <tr><td>GET</td><td><code>/index/status</code></td><td>Document counts per status</td></tr>
          <tr><td>POST</td><td><code>/index/reindex</code></td><td>Re-index one document or the whole project</td></tr>
          <tr><td>POST</td><td><code>/index/reindex-incomplete</code></td><td>Queue every document that is not <code>INDEXED</code></td></tr>
          <tr><td>GET</td><td><code>/search</code></td><td><code>?q=&amp;limit=&amp;threshold=</code> — <code>limit</code> 1–25 (default 8), <code>threshold</code> default 0.45</td></tr>
          <tr><td>GET</td><td><code>/usage</code></td><td>Embedding tokens spent on this project&apos;s corpus</td></tr>
        </tbody>
      </table>
      <p className="text-sm">
        A document moves <code>PENDING → PROCESSING → INDEXED</code>, or <code>FAILED</code>; if its
        source object changes it becomes <code>STALE</code> until re-indexed.
      </p>

      <h2>Notes &amp; limits</h2>
      <ul>
        <li>Vectors are stored at a fixed width of 1536 dimensions. A model with narrower vectors is zero-padded (cosine distance is unchanged); a wider model is refused.</li>
        <li>Switching a project to a different model re-embeds its existing vectors, up to a platform-set row limit.</li>
        <li>A <code>400</code> with <code>No OpenAI API key available</code> means neither the platform nor the project has a key for the selected provider.</li>
        <li>An anon key on a write returns <code>403</code>; deleting a namespace requires the service key.</li>
      </ul>
    </div>
  );
}
