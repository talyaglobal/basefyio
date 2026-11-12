import type { Metadata } from "next";
import Link from "next/link";
import { docsMetadata } from "../docs-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/data-engine", "Data Engine", "basefyio Data Engine: schema-driven NoSQL document storage with nested queries, versioning, and multi-tenant isolation.");
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
        The Data Engine supports two storage providers — a dedicated <strong>NoSQL store</strong> for production
        workloads and a <strong>PostgreSQL JSONB</strong> fallback that needs no extra infrastructure. Both implement the same
        interface; your application code works identically regardless of which provider is active.
      </p>

      <h2 id="collections-and-entities">Two document stores: JSON collections and entities</h2>
      <p>
        basefyio stores JSON documents in two places. They are separate systems with their own APIs; data is
        not shared or synced between them.
      </p>
      <div className="docs-table"><table>
        <thead><tr><th></th><th>JSON collections</th><th>Data Engine entities</th></tr></thead>
        <tbody>
          <tr><td>Where the data lives</td><td>Your project&apos;s own PostgreSQL database (one table per collection in the <code>nosql</code> schema, a JSONB <code>data</code> column)</td><td>The Data Engine store (a document database operated by the platform)</td></tr>
          <tr><td>Schema</td><td>None — any JSON object</td><td>Optional typed fields, checked on every write</td></tr>
          <tr><td>Created in the dashboard as</td><td>Data → New → <strong>JSON collection</strong> (badge <code>JSON</code>)</td><td>Data → New → <strong>Entity</strong> (badge <code>ENTITY</code>)</td></tr>
          <tr><td>API</td><td><code>/api/rest/v1/collections/:name</code> (apps, anon key + row-level security) and <code>/api/projects/:projectId/collections</code> (admin)</td><td><code>/api/v1/projects/:projectId/data/:entity</code> (service key only)</td></tr>
          <tr><td>SDK</td><td><code>bf.collection(&apos;posts&apos;)</code></td><td><code>bf.data.collection(&apos;patients&apos;)</code></td></tr>
          <tr><td>Document shape</td><td><code>{"{ id, data: { … }, created_at, updated_at }"}</code></td><td>Your fields plus the <code>_</code>-prefixed envelope (below)</td></tr>
          <tr><td>Versions, soft delete, If-Match</td><td>No — deletes are permanent</td><td>Yes</td></tr>
          <tr><td>Row-level security, realtime</td><td>Yes</td><td>No — server-side access with the service key</td></tr>
          <tr><td>SQL access</td><td>Yes — plain tables in your database</td><td>No</td></tr>
        </tbody>
      </table></div>
      <p>
        <strong>Which one?</strong> Use a <strong>JSON collection</strong> when browser or mobile clients read and write
        directly with the anon key and policies, or when you also want SQL access. Use an <strong>entity</strong> when the
        data is written by your backend and you want declared, validated fields, version checks and recoverable deletes.
      </p>
      <p>
        Both appear in the dashboard&apos;s Data page, and the query editor&apos;s <code>db.&lt;name&gt;.find()</code> reads
        either: an entity of that name first, otherwise a JSON collection. Calling the entity API with the name of a
        JSON collection answers <code>404</code> with the collection route to use instead. To move documents from one
        to the other, export them as JSON from one panel and import the file in the other.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Schema-driven documents</strong> — Define entities with typed fields. Documents are validated against your schema on every write.</li>
        <li><strong>Nested data</strong> — Objects inside objects, arrays of objects, repeatable sections. No flattening required.</li>
        <li><strong>Document versioning</strong> — Every document carries a <code>_version</code> and <code>_eventSequence</code>. Optimistic concurrency via <code>If-Match</code>.</li>
        <li><strong>Soft delete</strong> — Deleted documents are recoverable: read them with <code>includeSoftDeleted=true</code> and bring one back with <code>POST …/data/:entity/:id/restore</code>.</li>
        <li><strong>Multi-tenant isolation</strong> — Every query has <code>_projectId</code> injected server-side. Project A can never read Project B&apos;s data.</li>
        <li><strong>Schema history</strong> — Every change to an entity&apos;s fields publishes a new schema version. Documents already stored stay readable and are checked against the new fields the next time they are written.</li>
        <li><strong>Provider-agnostic</strong> — Switch between a document store and PostgreSQL with a single environment variable.</li>
      </ul>

      <h2>Document Envelope</h2>
      <p>Every stored document carries these reserved fields automatically:</p>
      <pre><code>{`{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "_entity": "patients",
  "_projectId": "5e3e8c04-c05d-49ed-9520-6c7f76b2f7f3",
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

      <div className="docs-table"><table>
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
      </table></div>
      <p>
        Entity field names cannot start with <code>_</code> (400). Envelope fields sent in a write body are ignored, so
        a document you read can be sent back unchanged. <code>_createdBy</code> is the dashboard user who wrote the
        document, or empty for writes made with the service key. <code>_lastEventId</code> is reserved and currently
        always <code>null</code>.
      </p>

      <h2>REST API</h2>
      <p>
        Base URL: <code>{`${apiUrl}/api`}</code>. Every route below needs your project&apos;s <strong>service key</strong> in
        the <code>apikey</code> header (or a dashboard session). The anon key is refused with <code>403</code> — except
        the health route — because the Data Engine runs with owner rights and no row-level policies: call it from your
        server, never from a browser bundle. For data that browser clients read directly, use a JSON collection.
      </p>

      <h3>Entity Management</h3>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>GET</code></td><td><code>/api/v1/projects/:projectId/entities</code></td><td>List all entity definitions (<code>?withCounts=true</code> adds <code>documentCount</code>)</td></tr>
          <tr><td><code>POST</code></td><td><code>/api/v1/projects/:projectId/entities</code></td><td>Create an entity definition (<code>409</code> if the name exists — names that differ only in case or punctuation count as the same)</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/projects/:projectId/entities/:entity</code></td><td>Get entity definition with fields and rules</td></tr>
          <tr><td><code>PATCH</code></td><td><code>/api/v1/projects/:projectId/entities/:entity</code></td><td>Change <code>displayName</code>, <code>description</code> or <code>fields</code> (a field change publishes a new schema version)</td></tr>
          <tr><td><code>DELETE</code></td><td><code>/api/v1/projects/:projectId/entities/:entity</code></td><td>Delete an entity. If it still holds documents the answer is <code>409</code>; add <code>?force=true</code> to delete them permanently too</td></tr>
        </tbody>
      </table></div>

      <h3>Document CRUD</h3>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>POST</code></td><td><code>/api/v1/projects/:projectId/data/:entity</code></td><td>Create a document; send an array (up to 1000) to insert several — all are validated before any is written</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/projects/:projectId/data/:entity</code></td><td>List/query documents (filter, sort, paginate)</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/projects/:projectId/data/:entity/count</code></td><td><code>{"{ count }"}</code> of the documents matching <code>filter</code></td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/projects/:projectId/data/:entity/:id</code></td><td>Get document by ID (<code>ETag</code> header = its version)</td></tr>
          <tr><td><code>PATCH</code></td><td><code>/api/v1/projects/:projectId/data/:entity/:id</code></td><td>Partial update: each top-level field you send replaces that field (shallow merge)</td></tr>
          <tr><td><code>PUT</code></td><td><code>/api/v1/projects/:projectId/data/:entity/:id</code></td><td>Full replacement</td></tr>
          <tr><td><code>DELETE</code></td><td><code>/api/v1/projects/:projectId/data/:entity/:id</code></td><td>Soft delete (<code>204</code>)</td></tr>
          <tr><td><code>POST</code></td><td><code>/api/v1/projects/:projectId/data/:entity/:id/restore</code></td><td>Undo a soft delete (<code>409</code> if the document is not deleted)</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/projects/:projectId/views/:name</code></td><td>Run a saved query by name and return it as a page (<code>bf.data.view()</code>)</td></tr>
        </tbody>
      </table></div>

      <h3>Query Parameters</h3>
      <div className="docs-table"><table>
        <thead><tr><th>Parameter</th><th>Type</th><th>Example</th></tr></thead>
        <tbody>
          <tr><td><code>filter</code></td><td>JSON object</td><td><code>{`{"status":"active","address.city":"Istanbul"}`}</code></td></tr>
          <tr><td><code>sort</code></td><td>JSON or text</td><td><code>{`[{"path":"_createdAt","direction":"desc"}]`}</code>, <code>{`{"_createdAt":-1}`}</code> or <code>-_createdAt,name</code></td></tr>
          <tr><td><code>select</code></td><td>field list</td><td><code>name,address.city</code> — only these fields (the envelope is always returned)</td></tr>
          <tr><td><code>limit</code></td><td>number</td><td><code>50</code> by default, 1–1000 (larger values are capped; 0, negative or non-numeric values are a <code>400</code>)</td></tr>
          <tr><td><code>offset</code></td><td>number</td><td><code>0</code></td></tr>
          <tr><td><code>cursor</code></td><td>text</td><td>The <code>nextCursor</code> of the previous page — continues where it ended</td></tr>
          <tr><td><code>includeSoftDeleted</code></td><td>boolean</td><td><code>true</code> also returns deleted documents (also on <code>GET …/:id</code> and <code>/count</code>)</td></tr>
        </tbody>
      </table></div>
      <p>
        The response is a page: <code>{"{ data, total, hasMore, nextCursor? }"}</code>. Without a sort, documents come
        newest first; equal sort values are ordered by <code>_id</code>, so paging never skips or repeats a document.
      </p>

      <h3 id="filters">Filters</h3>
      <p>
        A filter is a JSON object. A plain value means equality; on an array field, equality matches when any element
        is equal. Address nested fields with dotted paths (<code>address.city</code>) — a nested object as a value is
        rejected with a hint to use the dotted path. Several keys are combined with AND.
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Operator</th><th>Meaning</th><th>Example</th></tr></thead>
        <tbody>
          <tr><td><code>$eq</code>, <code>$ne</code></td><td>equal / not equal</td><td><code>{`{"status":{"$ne":"archived"}}`}</code></td></tr>
          <tr><td><code>$gt</code>, <code>$gte</code>, <code>$lt</code>, <code>$lte</code></td><td>comparison (values of the same type)</td><td><code>{`{"total":{"$gte":10,"$lt":100}}`}</code></td></tr>
          <tr><td><code>$in</code>, <code>$nin</code></td><td>one of / none of a list (max 1000 values)</td><td><code>{`{"grp":{"$in":["g1","g2"]}}`}</code></td></tr>
          <tr><td><code>$contains</code>, <code>$containsAny</code></td><td>the array holds the value / any of the values</td><td><code>{`{"tags":{"$contains":"vip"}}`}</code></td></tr>
          <tr><td><code>$exists</code></td><td>the field is present (<code>true</code>) or missing (<code>false</code>)</td><td><code>{`{"deletedBy":{"$exists":false}}`}</code></td></tr>
          <tr><td><code>$like</code>, <code>$ilike</code></td><td>pattern with <code>%</code> and <code>_</code>; <code>$ilike</code> ignores case</td><td><code>{`{"name":{"$ilike":"jo%"}}`}</code></td></tr>
          <tr><td><code>$regex</code>, <code>$iregex</code></td><td>regular expression (max 512 characters)</td><td><code>{`{"sku":{"$regex":"^A-"}}`}</code></td></tr>
          <tr><td><code>$and</code>, <code>$or</code>, <code>$not</code></td><td>combine filters</td><td><code>{`{"$or":[{"grp":"g1"},{"total":{"$gt":5}}]}`}</code></td></tr>
        </tbody>
      </table></div>
      <p>
        The structured form used by earlier releases keeps working:{" "}
        <code>{`{"type":"field","path":{"path":"grp"},"operator":"eq","value":"g1"}`}</code>, combined with{" "}
        <code>{`{"type":"and","conditions":[…]}`}</code>, <code>or</code> and <code>{`{"type":"not","condition":…}`}</code>; its operator
        names are the ones above without <code>$</code> (<code>neq</code> for <code>$ne</code>). An invalid filter or sort is a{" "}
        <code>400</code> that names the problem.
      </p>

      <h3 id="writes">Writes, validation and limits</h3>
      <ul>
        <li><strong>Validation</strong> — when an entity has fields, every create and replace must include the required ones and every value must match its type (text, number, boolean, date, email, URL, lists, nested objects and their own required fields, plus rules such as <code>minLength</code> or <code>maxValue</code>). A <code>PATCH</code> checks only the fields it sends, but cannot set a required field to <code>null</code>. Fields that are not declared are allowed. A violation is a <code>422</code> listing every problem, e.g. <code>Validation failed: lastName: is required; age: must be a number, got a string</code>.</li>
        <li><strong>Existing documents</strong> — validation applies to writes only. Documents stored before a field was added or changed stay readable and are checked when they are next written.</li>
        <li><strong>PATCH is shallow</strong> — <code>{`{"address":{"city":"Ankara"}}`}</code> replaces the whole <code>address</code> object; send every nested field you want to keep, or use <code>PUT</code> with the complete document.</li>
        <li><strong>Limits</strong> — a document larger than <code>DATA_ENGINE_MAX_DOC_KB</code> (1024 KB) is a <code>413</code>; nesting deeper than <code>DATA_ENGINE_MAX_NESTING_DEPTH</code> (8 levels of objects/arrays) or an array longer than <code>DATA_ENGINE_MAX_ARRAY_ITEMS</code> (1000) is a <code>422</code>. The body must be a JSON object (or, on <code>POST</code>, an array of objects).</li>
        <li><strong>Rate limit</strong> — the API accepts 300 requests per minute per client; beyond that it answers <code>429</code>. Insert in bulk (an array of up to 1000 documents per request) instead of one request per document.</li>
      </ul>

      <h3 id="concurrency">Optimistic concurrency</h3>
      <p>
        Every document read returns its version in the <code>ETag</code> header (and in <code>_version</code>). Send it
        back as <code>If-Match</code> on <code>PATCH</code>, <code>PUT</code>, <code>DELETE</code> or <code>/restore</code>: if someone
        changed the document in the meantime the write is refused with <code>409</code> and nothing is changed. Without
        <code>If-Match</code> the write always applies.
      </p>
      <pre><code>{`curl -X PATCH "${apiUrl}/api/v1/projects/$PROJECT_ID/data/patients/$ID" \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -H 'If-Match: "4"' -d '{"age": 37}'
# 200 with the new document and ETag "5" — or 409 if the document is no longer at version 4`}</code></pre>

      <h3 id="errors">Errors</h3>
      <div className="docs-table"><table>
        <thead><tr><th>Status</th><th>When</th></tr></thead>
        <tbody>
          <tr><td><code>400</code></td><td>Invalid filter, sort, select, limit or If-Match; a body that is not a JSON object; an invalid entity definition</td></tr>
          <tr><td><code>403</code></td><td>The anon key, or a user who is not a member of the project&apos;s team</td></tr>
          <tr><td><code>404</code></td><td>Unknown entity (the message points to the collections API when the name is a JSON collection) or unknown document</td></tr>
          <tr><td><code>409</code></td><td>Version conflict (If-Match), an entity that already exists, deleting an entity that still holds documents, restoring a document that is not deleted</td></tr>
          <tr><td><code>413</code></td><td>Document larger than the size limit</td></tr>
          <tr><td><code>422</code></td><td>Schema validation failed, or the nesting/array limit was exceeded</td></tr>
          <tr><td><code>429</code></td><td>Rate limit</td></tr>
          <tr><td><code>503</code></td><td>The Data Engine is disabled on this deployment or its store is still starting</td></tr>
        </tbody>
      </table></div>
      <p>Error bodies are <code>{"{ statusCode, message, code }"}</code>; <code>code</code> is stable (e.g. <code>CONCURRENCY_CONFLICT</code>, <code>SCHEMA_VALIDATION_FAILED</code>, <code>ENTITY_NOT_FOUND</code>).</p>

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

// Soft delete
await bf.data.collection('patients').delete(patient._id)

// List entities
const { data: entities } = await bf.data.listEntities()

// Read a server-defined projection / view (paginated)
const { data: feed } = await bf.data.view('mobileFeedCard', { limit: 20 })
// feed.data[]  feed.total  feed.hasMore  feed.nextCursor
// params: { limit?, offset?, cursor? }

// Insert many (one request, up to 1000) and count
await bf.data.collection('patients').insertMany([{ firstName: 'Ada', lastName: 'L', address: { city: 'Izmir', country: 'TR' } }])
const { data: n } = await bf.data.collection('patients').count({ 'address.city': 'Izmir' })

// Optimistic concurrency: only update if nobody changed it since you read it
await bf.data.collection('patients').update(doc._id, { tags: ['vip'] }, { ifMatch: doc._version })

// Undo a soft delete
await bf.data.collection('patients').restore(patient._id)

// Health check
const { data: health } = await bf.data.health()
// => { available: true, reachable: true }`}</code></pre>
      <p>
        A <strong>view</strong> is a saved query (Data → Query editor → Save, or <code>POST /api/v1/projects/:projectId/data-query/saved</code>);
        <code>bf.data.view(name)</code> runs it and pages through the result with <code>limit</code>, <code>offset</code> or the
        returned <code>nextCursor</code>.
      </p>

      <h2>Entity Schema System</h2>
      <p>
        Entity definitions live in the platform database, not in the document store.
        Each entity has typed fields that compile to JSON Schema for validation.
      </p>

      <h3>Field Kinds</h3>
      <div className="docs-table"><table>
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
      </table></div>

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
      <div className="docs-table"><table>
        <thead><tr><th>Provider</th><th>When to Use</th><th>Configuration</th></tr></thead>
        <tbody>
          <tr><td><strong>Document store</strong></td><td>Production — optimized for document workloads</td><td><code>DATA_ENGINE_PROVIDER=mongodb</code> (also <code>nosql</code>, <code>couchdb</code>)</td></tr>
          <tr><td><strong>PostgreSQL (JSONB)</strong></td><td>Development, small installs — no extra infrastructure, uses the platform database</td><td><code>DATA_ENGINE_PROVIDER=postgres</code></td></tr>
          <tr><td><strong>Disabled</strong></td><td>Skip Data Engine entirely (existing features unaffected)</td><td><code>DATA_ENGINE_PROVIDER=disabled</code></td></tr>
        </tbody>
      </table></div>

      <h2>Configuration</h2>
      <div className="docs-table"><table>
        <thead><tr><th>Variable</th><th>Default</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>DATA_ENGINE_PROVIDER</code></td><td><code>disabled</code></td><td>Provider: <code>mongodb</code>, <code>nosql</code>, <code>couchdb</code>, <code>postgres</code>, or <code>disabled</code>. A document store that cannot be reached falls back to <code>postgres</code>.</td></tr>
          <tr><td><code>NOSQL_CONNSTR</code></td><td>—</td><td>NoSQL store connection string</td></tr>
          <tr><td><code>NOSQL_USERNAME</code></td><td>—</td><td>Store admin username</td></tr>
          <tr><td><code>NOSQL_PASSWORD</code></td><td>—</td><td>Store admin password</td></tr>
          <tr><td><code>DATA_ENGINE_CONTAINER</code></td><td><code>basefyio-apps</code></td><td>Top-level container name</td></tr>
          <tr><td><code>DATA_ENGINE_NAMESPACE</code></td><td><code>projects</code></td><td>Default namespace</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_DOC_KB</code></td><td><code>1024</code></td><td>Max document size in KB</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_NESTING_DEPTH</code></td><td><code>8</code></td><td>Max nesting depth of a document (and of entity field definitions)</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_ARRAY_ITEMS</code></td><td><code>1000</code></td><td>Max items in any array of a document</td></tr>
          <tr><td><code>DATA_ENGINE_SCHEMA_VALIDATION</code></td><td><code>enforce</code></td><td><code>off</code> skips the field checks on writes (the size, depth and array limits still apply)</td></tr>
        </tbody>
      </table></div>

      <h2>Admin Dashboard — Data Tab</h2>
      <p>
        Each project&apos;s <strong>Data</strong> tab in the dashboard provides:
      </p>
      <ul>
        <li><strong>One sidebar</strong> — SQL tables, JSON collections and entities together, each with its badge and document count</li>
        <li><strong>Entities</strong> — create with fields (a simple editor, or JSON for nested objects), edit fields later, delete (with its documents after a typed confirmation)</li>
        <li><strong>Document browser</strong> — Expandable JSON cards with envelope metadata (version, status, timestamps); &quot;Show deleted&quot; lists soft-deleted documents with a Restore button</li>
        <li><strong>Filters</strong> — the filter language above, e.g. <code>{`{"status":"active"}`}</code>; mistakes are explained under the filter box</li>
        <li><strong>Insert / Edit / Delete</strong> — the editor saves the whole document, so removing a field removes it; a save that would overwrite someone else&apos;s change is refused</li>
        <li><strong>Export / Import</strong> — download every document as a JSON file, or import a JSON array (or one object per line)</li>
        <li><strong>JSON collections</strong> — the same browser, plus index management (nested paths such as <code>address.city</code>); deletes ask for confirmation and are permanent</li>
      </ul>

      <h2 id="json-collections">JSON collections API</h2>
      <p>
        JSON collections are tables in your project database with one JSONB <code>data</code> column. Documents look like{" "}
        <code>{`{"id":"<uuid>","data":{…},"created_at":"…","updated_at":"…"}`}</code>. Applications use{" "}
        <code>/api/rest/v1/collections/:collection</code> with the anon key (row-level security applies) or the service key.
        Creating, dropping and indexing collections uses the administrative routes with the service key.
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>GET</code></td><td><code>/api/rest/v1/collections/:collection</code></td><td>Query: <code>filter</code>, <code>sort</code> (<code>{`{"field":1|-1}`}</code>), <code>project</code>, <code>limit</code> (max 1000), <code>offset</code></td></tr>
          <tr><td><code>POST</code></td><td><code>/api/rest/v1/collections/:collection</code></td><td>Insert one object or an array</td></tr>
          <tr><td><code>GET</code> / <code>PATCH</code> / <code>PUT</code> / <code>DELETE</code></td><td><code>/api/rest/v1/collections/:collection/:docId</code></td><td>Read, merge, replace, delete (permanent)</td></tr>
          <tr><td><code>POST</code></td><td><code>/api/projects/:projectId/collections</code></td><td>Create — <code>{`{"name":"posts"}`}</code>: letters, digits, underscores, up to 63 characters</td></tr>
          <tr><td><code>DELETE</code></td><td><code>/api/projects/:projectId/collections/:collectionName</code></td><td>Drop a collection and its documents (<code>404</code> if it does not exist)</td></tr>
          <tr><td><code>GET</code> / <code>POST</code></td><td><code>/api/projects/:projectId/collections/:collectionName/indexes</code></td><td>List indexes / add one: <code>{`{"fieldPath":"address.city"}`}</code></td></tr>
          <tr><td><code>DELETE</code></td><td><code>/api/projects/:projectId/collections/:collectionName/indexes/:indexName</code></td><td>Drop an index you added</td></tr>
        </tbody>
      </table></div>
      <p>
        Collection filters use the same shape as entity filters: equality (which also matches an element of an array
        field and works on dotted paths such as <code>{`{"meta.city":"Ankara"}`}</code>), <code>$eq</code>, <code>$ne</code>,{" "}
        <code>$gt</code>/<code>$gte</code>/<code>$lt</code>/<code>$lte</code> (numbers), <code>$in</code>/<code>$nin</code>,{" "}
        <code>$contains</code>, <code>$all</code>, <code>$elemMatch</code> (e.g.{" "}
        <code>{`{"items":{"$elemMatch":{"sku":"A","qty":{"$gt":2}}}}`}</code>), <code>$exists</code>,{" "}
        <code>$regex</code>/<code>$iregex</code>, <code>$like</code>/<code>$ilike</code>, <code>$and</code> and <code>$or</code>. A nested
        object as a value matches documents that contain it. Without a sort, documents come in creation order.
        Malformed JSON, an invalid document id or an unknown operator is a <code>400</code>.
      </p>
    </div>
  );
}
