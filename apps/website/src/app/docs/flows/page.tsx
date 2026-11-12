import type { Metadata } from "next";
import Link from "next/link";
import { docsMetadata } from "../docs-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio Flows: named automations with ordered steps that run on the background job queue, with a recorded result for every run.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/flows", "Flows", pageDescription);
}

export default function FlowsDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>Flows</h1>
      <p>
        A <strong>flow</strong> is a named trigger plus an ordered list of actions. When a flow
        runs, its actions execute one after another on the platform&apos;s background job queue,
        and the run is recorded with the input it was given and the result of every step — so you
        can see exactly what happened.
      </p>
      <p>
        Manage flows from the project&apos;s <strong>Flows</strong> page in the dashboard, or over the
        REST API with the project&apos;s <strong>service key</strong> or a dashboard session. The anon
        key is refused: a flow can call external URLs, so starting one is a server-side decision.
      </p>

      <h2>A flow definition</h2>
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
      <div className="docs-table"><table>
        <thead><tr><th>Field</th><th>Rules</th></tr></thead>
        <tbody>
          <tr><td><code>name</code></td><td>Required.</td></tr>
          <tr><td><code>trigger</code></td><td>How the flow starts. A flow is started by calling its <code>trigger</code> route (below); <code>manual</code> is the trigger type to use.</td></tr>
          <tr><td><code>actions</code></td><td>At least one. <code>log</code> records a <code>message</code>; <code>http.request</code> calls a URL with <code>method</code>, <code>url</code>, optional <code>headers</code> and <code>body</code>.</td></tr>
          <tr><td><code>continueOnError</code></td><td>Per action. Without it, a failing action stops the run.</td></tr>
          <tr><td><code>enabled</code></td><td>A disabled flow cannot be triggered.</td></tr>
        </tbody>
      </table></div>
      <p>
        An <code>http.request</code> URL is checked when the step runs: loopback, private and
        link-local addresses are refused, so a flow cannot be used to reach internal services.
      </p>

      <h2>Run a flow</h2>
      <pre><code>{`API=${apiUrl}/api

# Create
curl -s "$API/projects/$PROJECT_ID/flows" \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"ping","trigger":{"type":"manual"},"actions":[{"type":"http.request","method":"GET","url":"https://example.com/health"}]}'

# Run it now, with optional input
curl -s -X POST "$API/projects/$PROJECT_ID/flows/$FLOW_ID/trigger" \\
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \\
  -d '{"input":{"reason":"test"}}'
# → { "runId": "…", "status": "…" }

# See what happened
curl -s "$API/projects/$PROJECT_ID/flows/$FLOW_ID/runs" -H "apikey: $SERVICE_KEY"`}</code></pre>
      <p>
        A run records its status, its input and one <code>{`{ type, ok, status?, detail? }`}</code>{" "}
        entry per action.
      </p>

      <h2>Routes</h2>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>GET</td><td><code>/api/projects/:projectId/flows</code></td><td>List flows</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/flows</code></td><td>Create a flow</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/flows/:id</code></td><td>One flow</td></tr>
          <tr><td>PATCH</td><td><code>/api/projects/:projectId/flows/:id</code></td><td>Replace the definition</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/flows/:id</code></td><td>Delete</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/flows/:id/enable</code></td><td>Enable</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/flows/:id/disable</code></td><td>Disable</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/flows/:id/trigger</code></td><td>Run now; body <code>{`{ "input": … }`}</code> is optional</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/flows/:id/runs</code></td><td>The latest runs, newest first</td></tr>
        </tbody>
      </table></div>

      <h2>Errors</h2>
      <div className="docs-table"><table>
        <thead><tr><th>Status</th><th>When</th></tr></thead>
        <tbody>
          <tr><td>400</td><td>An invalid definition (missing name, unknown action type, an <code>http.request</code> without a URL), or <code>Flow is disabled</code></td></tr>
          <tr><td>403</td><td>The anon key, or a caller who is not a member of the project&apos;s team</td></tr>
          <tr><td>404</td><td><code>Flow not found</code></td></tr>
        </tbody>
      </table></div>

      <hr />
      <p>
        Calling your own functions instead? Every SQL function is also reachable as{" "}
        <code>POST /api/rest/v1/rpc/:fn</code> — see the <Link href="/docs/api">API reference</Link>.
      </p>
    </div>
  );
}
