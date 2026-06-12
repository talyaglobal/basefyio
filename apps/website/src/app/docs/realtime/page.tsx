import type { Metadata } from "next";
import Link from "next/link";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";

const pageDescription =
  "Subscribe to live INSERT/UPDATE/DELETE events on your basefyio tables and collections with the SDK or plain EventSource.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/realtime", {
    title: "Realtime",
    description: pageDescription,
    openGraph: { title: "Realtime | basefyio Docs", description: pageDescription },
  });
}

export default function RealtimeDocs() {
  return (
    <div>
      <h1>Realtime</h1>
      <p>
        Subscribe to live data changes — every INSERT, UPDATE, and DELETE on an enabled table or
        collection is pushed to connected clients the moment it happens. No polling.
      </p>

      <h2>1. Enable realtime per table</h2>
      <p>
        Nothing broadcasts by default. Open your project&apos;s <strong>Settings → Realtime</strong>{" "}
        and switch on the tables or collections your app should broadcast. This is an explicit
        opt-in: change events carry full row data and are delivered to anyone holding a project
        API key, independent of row-level security.
      </p>

      <h2>2. Subscribe with the SDK</h2>
      <pre><code>{`import { createClient } from 'basefyio-js';

const bf = createClient({ apiUrl, projectId, apiKey });

const sub = bf.realtime.subscribe(
  { table: 'orders', event: 'INSERT' },
  (change) => {
    console.log('new order:', change.new);
  },
);

// NoSQL collections work the same way:
bf.realtime.subscribe({ collection: 'messages' }, (change) => {
  console.log(change.type, change.new ?? change.old);
});

// Stop listening:
sub.unsubscribe();`}</code></pre>
      <p>
        <code>event</code> filters by change type (<code>INSERT</code>, <code>UPDATE</code>,{" "}
        <code>DELETE</code>, or <code>*</code> for all — the default). Omit{" "}
        <code>table</code>/<code>collection</code> to receive every enabled entity&apos;s events.
        The SDK reconnects automatically with exponential backoff.
      </p>

      <h2>Change payload</h2>
      <pre><code>{`{
  "eventId": "9b2f…",
  "type": "UPDATE",            // INSERT | UPDATE | DELETE
  "kind": "table",             // table | collection
  "entity": "orders",
  "new": { "id": 42, "status": "paid", … },   // null on DELETE
  "old": { "id": 42 },                         // identifying fields; null on INSERT
  "commitTimestamp": "2026-06-12T15:04:05.000Z"
}`}</code></pre>

      <h2>Plain EventSource (no SDK)</h2>
      <pre><code>{`const url = 'https://api.basefyio.com/api/realtime/v1/stream'
  + '?apikey=YOUR_ANON_KEY'
  + '&channels=table:orders,collection:messages';

const es = new EventSource(url);
es.addEventListener('data_change', (e) => {
  const change = JSON.parse(e.data);
  console.log(change.type, change.entity, change.new);
});`}</code></pre>
      <p>
        The API key travels as a query parameter because EventSource cannot set headers. A{" "}
        <code>ping</code> event arrives every 25 seconds to keep the connection alive.
      </p>

      <h2>What triggers events</h2>
      <ul>
        <li>REST API writes (<code>POST/PATCH/DELETE /api/rest/v1/&#123;table&#125;</code>)</li>
        <li>SDK writes (<code>bf.from(...)</code> inserts/updates/deletes)</li>
        <li>Dashboard table editor and collection document edits</li>
      </ul>
      <p>
        Raw SQL executed in the SQL editor or from an external client does <strong>not</strong>{" "}
        broadcast in this version — events are produced at the API layer, not from the
        write-ahead log.
      </p>

      <h2>Node.js</h2>
      <p>
        Node 22+ ships a global <code>EventSource</code>. On older versions install a polyfill
        (e.g. <code>eventsource</code>) and assign it to <code>globalThis.EventSource</code>{" "}
        before calling <code>bf.realtime.subscribe()</code>.
      </p>

      <hr />
      <p>
        See the <Link href="/docs/sdk">SDK reference</Link> for the full client API.
      </p>
    </div>
  );
}
