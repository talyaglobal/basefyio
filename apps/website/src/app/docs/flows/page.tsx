import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio Flows: a named trigger plus an ordered list of actions (log, HTTP request), run in the background with a recorded result for every step — from the dashboard or the REST API.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/flows", {
    title: "Flows",
    description: pageDescription,
    openGraph: {
      title: "Flows | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function FlowsDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>Flows</h1>
      <p>
        A <strong>flow</strong> is a named <strong>trigger</strong> plus an ordered list of{" "}
        <strong>actions</strong>. When the flow is triggered, its actions run in order on the
        platform&apos;s background job queue, and every run is recorded with the result of each
        step. Use flows to call a webhook after something happens in your app, or to automate a
        routine call without running your own worker.
      </p>

      <h2>Concepts</h2>
      <table>
        <thead>
          <tr><th>Term</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Trigger</strong></td><td><code>manual</code>, <code>webhook</code> or <code>schedule</code>. Only <code>manual</code> can be fired today — you start it from the dashboard or the <code>trigger</code> route. <code>webhook</code> and <code>schedule</code> definitions are accepted and stored, but nothing receives or schedules them yet.</td></tr>
          <tr><td><strong>Action</strong></td><td>A step. <code>log</code> writes a message; <code>http.request</code> calls a URL (<code>method</code>, <code>url</code>, optional <code>headers</code> and <code>body</code>).</td></tr>
          <tr><td><strong>Run</strong></td><td>One execution. It stores its status, the input it was given and one <code>{`{ type, ok, status?, detail? }`}</code> result per action.</td></tr>
        </tbody>
      </table>

      <h2>In the dashboard</h2>
      <p>Open your project and choose <strong>Flows</strong>.</p>
      <ul>
        <li><strong>New flow</strong> — give it a name, pick a trigger, and add one or more actions (a message to log, or a method and URL to call).</li>
        <li><strong>Run</strong> — trigger a flow now. A disabled flow cannot be run.</li>
        <li>Enable or disable a flow, review its recent runs, or delete it.</li>
      </ul>

      <h2>Definition</h2>
      <pre><code>{`{
  "name": "Notify on signup",
  "trigger": { "type": "manual" },
  "actions": [
    { "type": "log", "message": "new signup" },
    {
      "type": "http.request",
      "method": "POST",
      "url": "https://hooks.example.com/signup",
      "headers": { "Content-Type": "application/json" },
      "body": { "source": "basefyio" },
      "continueOnError": false
    }
  ],
  "enabled": true
}`}</code></pre>
      <ul>
        <li><code>name</code> is required, and there must be at least one action.</li>
        <li>If an action fails, the run stops — unless that action sets <code>continueOnError</code>.</li>
        <li>
          An <code>http.request</code> URL is checked when it runs: loopback, private and
          link-local addresses and the platform&apos;s own internal hosts are refused, so a flow
          cannot be used to reach internal services.
        </li>
      </ul>

      <h2>REST API</h2>
      <p>
        All routes are under <code>{`${apiUrl}/api/projects/:projectId/flows`}</code>. They need
        your project&apos;s <strong>service key</strong> (<code>apikey</code> header) or a dashboard
        session; the anon key is refused with 403.
      </p>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/</code></td><td>List flows</td></tr>
          <tr><td>POST</td><td><code>/</code></td><td>Create a flow</td></tr>
          <tr><td>GET</td><td><code>/:id</code></td><td>One flow</td></tr>
          <tr><td>PATCH</td><td><code>/:id</code></td><td>Replace the definition</td></tr>
          <tr><td>DELETE</td><td><code>/:id</code></td><td>Delete — returns <code>{`{ deleted: true }`}</code></td></tr>
          <tr><td>POST</td><td><code>/:id/enable</code></td><td>Enable</td></tr>
          <tr><td>POST</td><td><code>/:id/disable</code></td><td>Disable</td></tr>
          <tr><td>POST</td><td><code>/:id/trigger</code></td><td>Run now. Optional body <code>{`{ "input": … }`}</code>; returns <code>{`{ runId, status }`}</code></td></tr>
          <tr><td>GET</td><td><code>/:id/runs</code></td><td>The last 50 runs, newest first</td></tr>
        </tbody>
      </table>

      <h3>Example</h3>
      <pre><code>{`API=${apiUrl}/api

# Create a flow
FLOW=$(curl -s $API/projects/$PROJECT_ID/flows \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"ping","trigger":{"type":"manual"},"actions":[{"type":"http.request","method":"GET","url":"https://example.com/health"}]}' \\
  | jq -r .id)

# Run it, then read the result of each step
curl -s -X POST $API/projects/$PROJECT_ID/flows/$FLOW/trigger \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{"input":{"reason":"test"}}'
curl -s $API/projects/$PROJECT_ID/flows/$FLOW/runs -H "apikey: $SERVICE_KEY"`}</code></pre>

      <h2>Errors</h2>
      <ul>
        <li><strong>400</strong> — a missing <code>name</code>, an unknown trigger or action type, no actions, an <code>http.request</code> without a <code>url</code>, or triggering a disabled flow (<code>Flow is disabled</code>).</li>
        <li><strong>403</strong> — the anon key, or a caller who is not a member of the project&apos;s team.</li>
        <li><strong>404</strong> — <code>Flow not found</code>.</li>
      </ul>
    </div>
  );
}
