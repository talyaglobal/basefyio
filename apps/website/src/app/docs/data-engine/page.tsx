import type { Metadata } from "next";
import Link from "next/link";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/data-engine", {
    title: "Data Engine",
    description: "basefyio Data Engine: schema-driven document storage with nested queries, versioning, multi-tenant isolation, and vectors stored alongside records.",
  });
}

export default function DataEngineDocs() {
  const apiUrl = getPublicApiUrl();
  return (
    <div>
      <h1>basefyio Data Engine</h1>
      <p>
        The <strong>basefyio Data Engine</strong> is a document data plane that runs alongside your existing
        dedicated databases. Store flexible, schema-driven documents with nested objects, arrays, versioning,
        soft-delete, and automatic multi-tenant isolation.
      </p>
      <p>
        The operator chooses the document store: <strong>MongoDB</strong>, <strong>Couchbase</strong>,{" "}
        <strong>CouchDB</strong>, or JSONB tables in <strong>PostgreSQL</strong>. All of them implement the same
        interface, so your application code works the same whichever one is active. A few capabilities depend
        on the store (aggregation pipelines and vectors need MongoDB); <code>GET /v1/projects/:projectId/data-query/capabilities</code>{" "}
        tells your application what the active one supports.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Schema-driven documents</strong> — Define entities with typed fields. Documents are validated against your schema on every write.</li>
        <li><strong>Nested data</strong> — Objects inside objects, arrays of objects, repeatable sections. No flattening required.</li>
        <li><strong>Document versioning</strong> — Every document carries a <code>_version</code> and <code>_eventSequence</code>. Optimistic concurrency: send <code>If-Match: &quot;&lt;_version&gt;&quot;</code> on PATCH or PUT and a stale version answers <code>409</code>; reads and writes return the version as <code>ETag</code>.</li>
        <li><strong>Soft delete</strong> — Deleted documents are kept. List them with <code>?includeSoftDeleted=true</code> and bring one back with <code>POST /v1/projects/:projectId/data/:entity/:id/restore</code>.</li>
        <li><strong>Multi-tenant isolation</strong> — Every query has <code>_projectId</code> injected server-side. Project A can never read Project B&apos;s data.</li>
        <li><strong>Event system</strong> — Every write produces an outbox event: <code>document.created</code>, <code>document.updated</code>, <code>document.deleted</code>.</li>
        <li><strong>Vectors alongside records</strong> — On MongoDB, a record can carry a vector embedding next to its fields, and an entity can be searched by similarity. See <a href="#vectors">Vectors</a>.</li>
        <li><strong>Provider-agnostic</strong> — The operator switches the document store with a single environment variable.</li>
      </ul>

      <h2>Document Envelope</h2>
      <p>Every stored document carries these reserved fields automatically:</p>
      <pre><code>{`{
  "_id": "patients::550e8400-e29b-41d4-a716-446655440000",
  "_entity": "patients",
  "_projectId": "prj_abc123",
  "_schemaVersion": 1,
  "_version": 5,
  "_eventSequence": 5,
  "_status": "active",
  "_createdAt": "2026-06-09T10:00:00.000Z",
  "_updatedAt": "2026-06-09T15:30:00.000Z",
  "_createdBy": "user_456",
  "_deletedAt": null,
  "firstName": "John",
  "lastName": "Smith",
  "address": {
    "city": "Istanbul",
    "country": "TR"
  }
}`}</code></pre>

      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>_id</code></td><td>string</td><td>Unique document identifier</td></tr>
          <tr><td><code>_entity</code></td><td>string</td><td>Entity type name</td></tr>
          <tr><td><code>_projectId</code></td><td>string</td><td>Owning project (injected server-side, cannot be overridden)</td></tr>
          <tr><td><code>_schemaVersion</code></td><td>number</td><td>Schema version this document was written under</td></tr>
          <tr><td><code>_version</code></td><td>number</td><td>Optimistic concurrency token (CAS)</td></tr>
          <tr><td><code>_eventSequence</code></td><td>number</td><td>Monotonic counter per document (for offline sync)</td></tr>
          <tr><td><code>_status</code></td><td>string</td><td><code>active</code>, <code>draft</code>, <code>archived</code>, <code>deleted</code>, or <code>pending_approval</code></td></tr>
          <tr><td><code>_createdAt</code></td><td>ISO 8601</td><td>Creation timestamp</td></tr>
          <tr><td><code>_updatedAt</code></td><td>ISO 8601</td><td>Last modification timestamp</td></tr>
          <tr><td><code>_createdBy</code></td><td>string</td><td>User ID who created the document</td></tr>
          <tr><td><code>_deletedAt</code></td><td>ISO 8601 | null</td><td>Soft-delete timestamp (null if active)</td></tr>
        </tbody>
      </table>
      <p>
        User schemas cannot define fields starting with <code>_</code>. The system rejects them with HTTP 422.
      </p>

      <h2>REST API</h2>
      <p>Base path: <code>{apiUrl}/api/v1/projects/:projectId</code></p>

      <h3>Entity Management</h3>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>GET</code></td><td><code>/entities</code></td><td>List all entity definitions</td></tr>
          <tr><td><code>POST</code></td><td><code>/entities</code></td><td>Create an entity definition</td></tr>
          <tr><td><code>GET</code></td><td><code>/entities/:entity</code></td><td>Get entity definition with fields and rules</td></tr>
        </tbody>
      </table>

      <h3>Document CRUD</h3>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>POST</code></td><td><code>/data/:entity</code></td><td>Create a document</td></tr>
          <tr><td><code>GET</code></td><td><code>/data/:entity</code></td><td>List/query documents (filter, sort, paginate)</td></tr>
          <tr><td><code>GET</code></td><td><code>/data/:entity/:id</code></td><td>Get document by ID</td></tr>
          <tr><td><code>PATCH</code></td><td><code>/data/:entity/:id</code></td><td>Partial update (merge fields)</td></tr>
          <tr><td><code>PUT</code></td><td><code>/data/:entity/:id</code></td><td>Full replacement</td></tr>
          <tr><td><code>DELETE</code></td><td><code>/data/:entity/:id</code></td><td>Soft delete</td></tr>
        </tbody>
      </table>

      <p>Filters use Mongo-style operators (<code>$eq</code>, <code>$ne</code>, <code>$gt</code>, <code>$in</code>, <code>$contains</code>, <code>$and</code>, <code>$or</code>, <code>$not</code>, ...). <code>sort</code> accepts the array form or <code>{`{"field":-1}`}</code>. A malformed filter or sort returns <code>400</code>. Writes are validated against the entity fields (required fields and scalar types), the body must be a JSON object up to 1 MB (<code>413</code> above that), arrays are limited to 1000 items and nesting to 8 levels.</p>
      <h3>Query Parameters</h3>
      <table>
        <thead><tr><th>Parameter</th><th>Type</th><th>Example</th></tr></thead>
        <tbody>
          <tr><td><code>filter</code></td><td>JSON string</td><td><code>{`{"status":"active","address.city":"Istanbul"}`}</code></td></tr>
          <tr><td><code>sort</code></td><td>JSON string</td><td><code>{`[{"path":"_createdAt","direction":"desc"}]`}</code></td></tr>
          <tr><td><code>limit</code></td><td>number</td><td><code>50</code> (1 to 1000; anything else is a <code>400</code>)</td></tr>
          <tr><td><code>offset</code></td><td>number</td><td><code>0</code></td></tr>
          <tr><td><code>cursor</code></td><td>string</td><td>the <code>nextCursor</code> of the previous page (use it instead of <code>offset</code>)</td></tr>
        </tbody>
      </table>

      <h2 id="vectors">Vectors</h2>
      <p>
        Store vector embeddings alongside operational document data in MongoDB: each record of an entity can
        carry one vector next to its fields, and the entity can be searched for the records closest to a query
        vector or a text query. Vectors need the MongoDB provider; other providers answer{" "}
        <code>501 VECTOR_NOT_SUPPORTED</code>. Service key only, like the record routes. An entity&apos;s
        vectors come from one of two modes:
      </p>
      <ul>
        <li>
          <strong><code>platform</code></strong> — the platform computes each record&apos;s vector from the text of
          the fields you name (<code>sourcePaths</code>, 1 to 8 dot paths such as <code>title</code> or{" "}
          <code>body.text</code>), with your project&apos;s embedding model. After every create, update, replace or
          restore the vector is computed in the background, never inside your request; a write that does not
          change the text of those fields costs nothing. Search with <code>query</code> (text).
        </li>
        <li>
          <strong><code>client</code></strong> — you compute the vectors with the model of your choice and send
          them; the platform never calls an embedding model for these entities.
        </li>
      </ul>
      <ul>
        <li><strong>Stored with the record</strong> — the vector lives in the same document as the record, beside its fields, as packed float32 values scaled to unit length.</li>
        <li><strong>Never in record reads</strong> — <code>GET</code>, list, <code>PATCH</code>, <code>PUT</code> and aggregation results do not contain it, and writing a vector does not change the record&apos;s <code>_version</code> (ETag).</li>
        <li><strong>Soft delete</strong> — a deleted record keeps its vector but is never a search hit; restoring it makes it searchable again.</li>
        <li><strong>Off until you turn it on</strong> — an entity stores vectors only after its vector config is set; writes and searches before that answer <code>409</code>.</li>
      </ul>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>PUT</code></td><td><code>/entities/:entity/vector-config</code></td><td>Turn vectors on: <code>{`{ "mode": "platform", "sourcePaths": ["title", "body"] }`}</code> or <code>{`{ "mode": "client", "dimensions": 1536 }`}</code> (1 to 2048); <code>?purge=true</code> deletes existing vectors first (needed to switch mode while vectors exist)</td></tr>
          <tr><td><code>GET</code></td><td><code>/entities/:entity/vector-config</code></td><td>The entity&apos;s vector config (platform mode adds <code>sourcePaths</code> and <code>modelTag</code>)</td></tr>
          <tr><td><code>DELETE</code></td><td><code>/entities/:entity/vector-config</code></td><td>Turn vectors off; <code>?purge=true</code> is required when vectors exist and deletes them</td></tr>
          <tr><td><code>GET</code></td><td><code>/entities/:entity/vector-status</code></td><td><code>{`{ mode, dimensions, embedded, total, pending, failed, modelTag, mismatch, reembed, platformKeyAllowed, dailyTokens, ... }`}</code></td></tr>
          <tr><td><code>POST</code></td><td><code>/entities/:entity/reembed</code></td><td>Platform mode: re-embed every record with the project&apos;s current model (<code>202</code>; <code>409</code> while one runs)</td></tr>
          <tr><td><code>PUT</code></td><td><code>/data/:entity/:id/vector</code></td><td>Set the record&apos;s vector: <code>{`{ "vector": [ ... ] }`}</code></td></tr>
          <tr><td><code>GET</code></td><td><code>/data/:entity/:id/vector</code></td><td>The stored (unit-length) vector</td></tr>
          <tr><td><code>DELETE</code></td><td><code>/data/:entity/:id/vector</code></td><td>Remove the record&apos;s vector</td></tr>
          <tr><td><code>POST</code></td><td><code>/data/:entity/vectors</code></td><td>Up to 100 at once: <code>{`{ "items": [{ "id", "vector" }] }`}</code> → <code>{`{ written, missing }`}</code></td></tr>
          <tr><td><code>POST</code></td><td><code>/data/:entity/search</code></td><td>Nearest records: <code>{`{ vector | query, filter?, limit?, threshold? }`}</code> — exactly one of <code>vector</code> and <code>query</code></td></tr>
        </tbody>
      </table>
      <pre><code>{`# Platform mode: vectors computed from title + body
curl -s -X PUT ${apiUrl}/api/v1/projects/$PROJECT_ID/entities/articles/vector-config \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{ "mode": "platform", "sourcePaths": ["title", "body"] }'

curl -s -X POST ${apiUrl}/api/v1/projects/$PROJECT_ID/data/articles/search \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{ "query": "waterproof hiking boots", "filter": { "lang": "en" }, "limit": 5 }'

# Client mode: your own vectors
curl -s -X POST ${apiUrl}/api/v1/projects/$PROJECT_ID/data/articles/search \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{ "vector": [0.12, -0.03, ...], "filter": { "lang": "en" }, "limit": 5, "threshold": 0.5 }'

# => { "data": [ { "_id": "...", "title": "...", "_distance": 0.12, "_score": 0.88 } ],
#      "scanned": 840, "strategy": "exact" }`}</code></pre>
      <p>
        <code>filter</code> uses the same grammar as the list route and is applied before scoring;{" "}
        <code>limit</code> is 1 to 100 (default 10); <code>threshold</code> is the maximum cosine distance, 0 to 2
        (default 0.5). <code>_distance</code> is the cosine distance (0 = same direction) and <code>_score</code>{" "}
        is <code>1 - _distance</code>.
      </p>
      <p>
        Search is <strong>exact</strong>: it compares the query with every candidate (the entity&apos;s live records
        that match the filter and have a vector). One search compares at most 10&nbsp;000 vectors by default; when
        more records are candidates it answers <code>422 VECTOR_SCAN_LIMIT</code> instead of returning results
        from part of the entity. Narrow it with a <code>filter</code>. A vector of the wrong width is a{" "}
        <code>400</code>.
      </p>
      <p>
        <strong>Platform mode rules.</strong> A text <code>query</code> only works on platform-mode entities (on a
        client-mode entity it is a <code>400</code>: your vectors and the platform&apos;s query would come from
        different models). When your project&apos;s embedding model changes, nothing is re-embedded on its own:{" "}
        <code>vector-status</code> shows <code>mismatch: true</code> and text search answers{" "}
        <code>409 VECTOR_MODEL_MISMATCH</code> until you call <code>reembed</code> and it finishes.{" "}
        <code>pending</code> counts records still waiting for a vector, <code>failed</code> those whose last
        embedding failed. With the platform&apos;s key, computing embeddings needs the{" "}
        <strong>Pro plan or above</strong> (Legacy included; <code>403 EMBEDDING_PLAN_REQUIRED</code> otherwise,
        already when you set platform mode) and is limited to <strong>1,000,000 tokens per project per day</strong>{" "}
        (<code>429 EMBEDDING_DAILY_LIMIT</code>). With your own provider key it works on every plan, without a
        limit. See <Link href="/docs/ai#plans-and-the-daily-limit">plans and the daily limit</Link>.
      </p>
      <p>
        The document store is not yet covered by the platform&apos;s backups, so keep the vectors you send
        reproducible on your side (the source text and the model you used). Platform-mode vectors can be
        recomputed with <code>reembed</code>.
      </p>

      <h2>SDK Usage</h2>
      <pre><code>{`import { createClient } from 'basefyio-js'

const bf = createClient({ projectId: '...', apiKey: '...' })

// Create an entity
await bf.data.createEntity({
  logicalName: 'patients',
  displayName: 'Patients',
  fields: [
    { name: 'firstName', kind: 'scalar', type: 'text', required: true },
    { name: 'lastName', kind: 'scalar', type: 'text', required: true },
    { name: 'address', kind: 'object', children: [
      { name: 'city', kind: 'scalar', type: 'text', required: true },
      { name: 'country', kind: 'scalar', type: 'text', required: true },
    ]},
    { name: 'tags', kind: 'array', itemSchema: {
      name: 'tag', kind: 'scalar', type: 'text'
    }},
  ],
})

// Insert a document
const { data: patient } = await bf.data.collection('patients').insert({
  firstName: 'John',
  lastName: 'Smith',
  address: { city: 'Istanbul', country: 'TR' },
  tags: ['cardiology', 'vip'],
})

// Find documents with nested filter
const { data: results } = await bf.data.collection('patients')
  .find({ 'address.city': 'Istanbul' })
  .sort('_createdAt', 'desc')
  .limit(20)

// Get by ID
const { data: doc } = await bf.data.collection('patients').get(patient._id)

// Partial update (merge)
await bf.data.collection('patients').update(patient._id, {
  tags: ['cardiology', 'vip', 'follow-up'],
})

// Only if nobody changed it since you read it (409 otherwise, nothing written)
await bf.data.collection('patients').update(patient._id, { age: 37 }, { ifMatch: patient._version })

// Soft delete, list deleted documents, restore one
await bf.data.collection('patients').delete(patient._id)
const { data: withDeleted } = await bf.data.collection('patients').find().includeDeleted()
await bf.data.collection('patients').restore(patient._id)

// List entities
const { data: entities } = await bf.data.listEntities()

// Health check
const { data: health } = await bf.data.health()
// => { available: true, reachable: true }`}</code></pre>

      <h2>Entity Schema System</h2>
      <p>
        Entity definitions live in database metadata, not in the document store.
        Each entity has typed fields that compile to JSON Schema for validation.
      </p>

      <h3>Field Kinds</h3>
      <table>
        <thead><tr><th>Kind</th><th>Description</th><th>Example</th></tr></thead>
        <tbody>
          <tr><td><code>scalar</code></td><td>Simple value (text, number, boolean, date, email, phone, url)</td><td><code>firstName: text</code></td></tr>
          <tr><td><code>object</code></td><td>Nested object with child fields</td><td><code>address: {"{ city, country }"}</code></td></tr>
          <tr><td><code>array</code></td><td>Array with item schema</td><td><code>tags: [text]</code></td></tr>
          <tr><td><code>lookup</code></td><td>Reference to another entity</td><td><code>doctorId → doctors</code></td></tr>
          <tr><td><code>media</code></td><td>Rich media (url, dimensions, duration)</td><td><code>avatar: media</code></td></tr>
          <tr><td><code>counter</code></td><td>Numeric counter updated via events</td><td><code>views: counter</code></td></tr>
          <tr><td><code>attachment</code></td><td>File reference (url, mimeType, size)</td><td><code>report: attachment</code></td></tr>
        </tbody>
      </table>

      <h3>Nested Data Example</h3>
      <pre><code>{`// An entity with nested objects and arrays
{
  logicalName: 'orders',
  fields: [
    { name: 'customer', kind: 'object', children: [
      { name: 'name', kind: 'scalar', type: 'text', required: true },
      { name: 'address', kind: 'object', children: [
        { name: 'city', kind: 'scalar', type: 'text' },
        { name: 'country', kind: 'scalar', type: 'text' },
        { name: 'zip', kind: 'scalar', type: 'text' },
      ]},
    ]},
    { name: 'lineItems', kind: 'array', itemSchema: {
      name: 'lineItem', kind: 'object', children: [
        { name: 'productId', kind: 'scalar', type: 'text', required: true },
        { name: 'quantity', kind: 'scalar', type: 'number', required: true },
        { name: 'price', kind: 'scalar', type: 'currency' },
      ]
    }},
    { name: 'total', kind: 'scalar', type: 'currency', required: true },
  ]
}`}</code></pre>

      <h2>Storage Providers</h2>
      <table>
        <thead><tr><th>Provider</th><th>When to Use</th><th>Configuration</th></tr></thead>
        <tbody>
          <tr><td><strong>MongoDB</strong></td><td>Document workloads; the only provider with aggregation pipelines and vectors</td><td><code>DATA_ENGINE_PROVIDER=mongodb</code></td></tr>
          <tr><td><strong>Couchbase</strong></td><td>Document workloads on an existing Couchbase cluster</td><td><code>DATA_ENGINE_PROVIDER=nosql</code></td></tr>
          <tr><td><strong>CouchDB</strong></td><td>Document workloads on CouchDB (plain HTTP, no driver)</td><td><code>DATA_ENGINE_PROVIDER=couchdb</code></td></tr>
          <tr><td><strong>PostgreSQL</strong></td><td>No extra infrastructure: JSONB tables in the platform database</td><td><code>DATA_ENGINE_PROVIDER=postgres</code></td></tr>
          <tr><td><strong>Disabled</strong></td><td>Skip Data Engine entirely (existing features unaffected); every route answers 503</td><td><code>DATA_ENGINE_PROVIDER=disabled</code></td></tr>
        </tbody>
      </table>

      <h2>Configuration</h2>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>DATA_ENGINE_PROVIDER</code></td><td><code>disabled</code></td><td>Provider: <code>mongodb</code>, <code>nosql</code> (Couchbase), <code>couchdb</code>, <code>postgres</code>, or <code>disabled</code></td></tr>
          <tr><td><code>NOSQL_CONNSTR</code></td><td>—</td><td>Document store connection string</td></tr>
          <tr><td><code>NOSQL_USERNAME</code></td><td>—</td><td>Store admin username</td></tr>
          <tr><td><code>NOSQL_PASSWORD</code></td><td>—</td><td>Store admin password</td></tr>
          <tr><td><code>DATA_ENGINE_CONTAINER</code></td><td><code>basefyio-apps</code></td><td>Top-level container name</td></tr>
          <tr><td><code>DATA_ENGINE_NAMESPACE</code></td><td><code>projects</code></td><td>Default namespace</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_DOC_KB</code></td><td><code>1024</code></td><td>Max document size in KB</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_NESTING_DEPTH</code></td><td><code>8</code></td><td>Max schema nesting depth</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_ARRAY_ITEMS</code></td><td><code>1000</code></td><td>Max array items per field</td></tr>
          <tr><td><code>DATA_ENGINE_VECTOR_MAX_SCAN</code></td><td><code>10000</code></td><td>Most vectors one search compares (above it: <code>422 VECTOR_SCAN_LIMIT</code>)</td></tr>
          <tr><td><code>DATA_ENGINE_VECTOR_TIMEOUT_MS</code></td><td><code>5000</code></td><td>Server-side time limit of one vector search</td></tr>
        </tbody>
      </table>

      <h2>Admin Dashboard — Data Tab</h2>
      <p>
        Each project&apos;s <strong>Data</strong> tab in the dashboard provides:
      </p>
      <ul>
        <li><strong>Entity sidebar</strong> — Browse all entities, see AI-generated badges, search by name</li>
        <li><strong>Document browser</strong> — Expandable JSON cards with envelope metadata (version, status, timestamps)</li>
        <li><strong>JSON filter</strong> — Filter documents with JSON syntax, e.g. <code>{`{"status":"active"}`}</code></li>
        <li><strong>Insert / Edit / Delete</strong> — Full CRUD with JSON editors</li>
        <li><strong>Pagination</strong> — Server-side, 50 documents per page</li>
        <li><strong>Engine label</strong> — Read-only &quot;basefyio Data Engine&quot; badge</li>
      </ul>
    </div>
  );
}
