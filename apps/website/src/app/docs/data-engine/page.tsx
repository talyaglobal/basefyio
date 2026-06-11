import type { Metadata } from "next";
import Link from "next/link";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/data-engine", {
    title: "Data Engine",
    description: "Basefyio Data Engine: schema-driven NoSQL document storage with nested queries, versioning, and multi-tenant isolation.",
  });
}

export default function DataEngineDocs() {
  const apiUrl = getPublicApiUrl();
  return (
    <div>
      <h1>Basefyio Data Engine</h1>
      <p>
        The <strong>Basefyio Data Engine</strong> is a document data plane that runs alongside your existing
        dedicated databases. Store flexible, schema-driven documents with nested objects, arrays, versioning,
        soft-delete, and automatic multi-tenant isolation.
      </p>
      <p>
        The Data Engine supports two storage providers — a dedicated <strong>NoSQL store</strong> for production
        workloads and a <strong>database JSONB</strong> fallback for development. Both implement the same
        interface; your application code works identically regardless of which provider is active.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Schema-driven documents</strong> — Define entities with typed fields. Documents are validated against your schema on every write.</li>
        <li><strong>Nested data</strong> — Objects inside objects, arrays of objects, repeatable sections. No flattening required.</li>
        <li><strong>Document versioning</strong> — Every document carries a <code>_version</code> and <code>_eventSequence</code>. Optimistic concurrency via <code>If-Match</code>.</li>
        <li><strong>Soft delete</strong> — Deleted documents are recoverable. Query with <code>includeSoftDeleted</code> to see them.</li>
        <li><strong>Multi-tenant isolation</strong> — Every query has <code>_projectId</code> injected server-side. Project A can never read Project B&apos;s data.</li>
        <li><strong>Event system</strong> — Every write produces an outbox event: <code>document.created</code>, <code>document.updated</code>, <code>document.deleted</code>.</li>
        <li><strong>Provider-agnostic</strong> — Switch between NoSQL store and database with a single environment variable.</li>
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
      <p>Base path: <code>{apiUrl}/v1/projects/:projectId</code></p>

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

      <h3>Query Parameters</h3>
      <table>
        <thead><tr><th>Parameter</th><th>Type</th><th>Example</th></tr></thead>
        <tbody>
          <tr><td><code>filter</code></td><td>JSON string</td><td><code>{`{"status":"active","address.city":"Istanbul"}`}</code></td></tr>
          <tr><td><code>sort</code></td><td>JSON string</td><td><code>{`[{"path":"_createdAt","direction":"desc"}]`}</code></td></tr>
          <tr><td><code>limit</code></td><td>number</td><td><code>50</code> (max 1000)</td></tr>
          <tr><td><code>offset</code></td><td>number</td><td><code>0</code></td></tr>
        </tbody>
      </table>

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
          <tr><td><strong>NoSQL store</strong></td><td>Production — optimized for document workloads, full-text search, KV access</td><td><code>DATA_ENGINE_PROVIDER=nosql</code></td></tr>
          <tr><td><strong>database</strong></td><td>Development — no extra infrastructure, uses existing project DB</td><td><code>DATA_ENGINE_PROVIDER=database</code></td></tr>
          <tr><td><strong>Disabled</strong></td><td>Skip Data Engine entirely (existing features unaffected)</td><td><code>DATA_ENGINE_PROVIDER=disabled</code></td></tr>
        </tbody>
      </table>

      <h2>Configuration</h2>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>DATA_ENGINE_PROVIDER</code></td><td><code>disabled</code></td><td>Provider: <code>nosql</code>, <code>database</code>, or <code>disabled</code></td></tr>
          <tr><td><code>NOSQL_CONNSTR</code></td><td>—</td><td>NoSQL store connection string</td></tr>
          <tr><td><code>NOSQL_USERNAME</code></td><td>—</td><td>Store admin username</td></tr>
          <tr><td><code>NOSQL_PASSWORD</code></td><td>—</td><td>Store admin password</td></tr>
          <tr><td><code>DATA_ENGINE_CONTAINER</code></td><td><code>basefyio-apps</code></td><td>Top-level container name</td></tr>
          <tr><td><code>DATA_ENGINE_NAMESPACE</code></td><td><code>projects</code></td><td>Default namespace</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_DOC_KB</code></td><td><code>1024</code></td><td>Max document size in KB</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_NESTING_DEPTH</code></td><td><code>8</code></td><td>Max schema nesting depth</td></tr>
          <tr><td><code>DATA_ENGINE_MAX_ARRAY_ITEMS</code></td><td><code>1000</code></td><td>Max array items per field</td></tr>
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
        <li><strong>Engine label</strong> — Read-only &quot;Basefyio Data Engine&quot; badge</li>
      </ul>
    </div>
  );
}
