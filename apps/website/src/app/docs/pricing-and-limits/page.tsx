import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";

const pageDescription =
  "What a basefyio project gets and what it costs: plan limits, how storage is billed, compute, region, Enterprise, and what happens at each limit and in each rollout mode.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/pricing-and-limits", {
    title: "Pricing & Limits",
    description: pageDescription,
    openGraph: {
      title: "Pricing & Limits | basefyio Docs",
      description: pageDescription,
    },
  });
}

const PLAN_ROWS: Array<[string, string, string, string, string]> = [
  ["Price per month", "$0", "$20", "$100", "$0 (grandfathered)"],
  ["Projects", "2", "10", "100", "Unlimited"],
  ["Database size", "1 GB", "30 GB", "300 GB", "Unlimited"],
  ["File storage", "1 GB", "30 GB", "300 GB", "Unlimited"],
  ["Team members", "2", "10", "100", "Unlimited"],
  ["Egress per month", "1 GB", "50 GB", "500 GB", "Unlimited"],
  ["API requests per month", "50,000", "1,000,000", "10,000,000", "Unlimited"],
  ["Monthly active users", "50,000", "100,000", "Unlimited", "Unlimited"],
  ["Compute", "Shared", "Shared today", "Shared today", "Shared"],
  ["Embeddings on the platform's key", "—", "1,000,000 tokens / project / day", "1,000,000 tokens / project / day", "1,000,000 tokens / project / day"],
];

export default function PricingAndLimitsDocs() {
  return (
    <div>
      <h1>Pricing &amp; limits</h1>
      <p>
        What a project gets, what it costs, and what happens at a limit. Two short answers first.
      </p>
      <ul>
        <li>
          <strong>Is disk billed by the MB, or by package?</strong> By package. A plan is charged at its
          flat monthly price. Database size and file storage are not metered into the invoice: they are
          covered by the plan, up to the plan&apos;s limits.
        </li>
        <li>
          <strong>Is it unlimited?</strong> No, except on the <strong>Legacy</strong> plan (accounts that
          existed before the current plans; not offered to new customers), which has no caps. Free, Pro
          and Business each have a limit for database size and for file storage. <strong>Enterprise</strong>{" "}
          limits are agreed per organization (see below).
        </li>
      </ul>
      <p>
        The values below are the figures of the hosted service as of 2026-11-23. The Billing page in the
        dashboard and the public <code>GET /api/billing/plans</code> route show the ones in force, and are
        right if they differ. A self-hosted installation starts from different defaults.
      </p>

      <h2>Limits per plan</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Free</th>
            <th>Pro</th>
            <th>Business</th>
            <th>Legacy</th>
          </tr>
        </thead>
        <tbody>
          {PLAN_ROWS.map(([label, ...cells]) => (
            <tr key={label}>
              <td>{label}</td>
              {cells.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <strong>Enterprise</strong> is not bought in the dashboard: it is arranged with our team (
        <a href="mailto:support@talyasmart.com?subject=basefyio%20Enterprise">support@talyasmart.com</a>) and
        set up for the organization. Its limits are the ones agreed for the workload; a limit left empty
        means no cap. It is not listed in <code>GET /api/billing/plans</code>, and the Billing page does not
        offer a self-serve change to or from it.
      </p>
      <p>
        <strong>Limits are per organization</strong>, not per project: the database limit is compared with
        the sum of the sizes of all the organization&apos;s projects, and the file storage limit with all of
        their files. The project Overview shows both numbers.
      </p>

      <p>
        <strong>Embeddings.</strong> Computing embeddings with the platform&apos;s key (pgvector embeddings,
        and Data Engine vectors the platform computes from your records&apos; text) is included from the Pro
        plan, Legacy teams included, up to 1,000,000 tokens per project per UTC day; Enterprise gets the
        same. With the project&apos;s own embedding provider key it is available on every plan, without a
        limit.
      </p>

      <h2>What a project gets</h2>
      <ul>
        <li>
          <strong>Region and location</strong> — EU (Germany), Nuremberg. It is the only region today;
          data stays in the EU.
        </li>
        <li>
          <strong>Compute</strong> — every project runs on the platform&apos;s shared PostgreSQL server,
          together with other projects. It gets a share of the server&apos;s CPU and memory; no CPU or RAM is
          reserved for it, so there is no per-project RAM figure to quote. Dedicated sizes (Micro to XL,
          with a stated vCPU and RAM) are part of the Pro and Business plans&apos; design but are{" "}
          <strong>not available yet</strong>; the New project dialog lists them as disabled. When they
          open, the Overview shows the size, vCPU and RAM of the container.
        </li>
        <li>
          <strong>Connection</strong> — the host and port on the project&apos;s Overview and Connect pages.
          The host is a DNS name of the connection pooler (PgBouncer, port <code>6432</code> unless the
          operator changed it), not a fixed IP address: use the name, because the address behind it can
          change.
        </li>
        <li>
          <strong>Database and file storage against the limit</strong> — the Overview card shows this
          project&apos;s size, the organization&apos;s total and the plan&apos;s limit. The word{" "}
          <em>Unlimited</em> appears only for a plan that has no cap.
        </li>
      </ul>

      <h2>How storage is billed</h2>
      <p>
        A plan is charged once per billing period at its flat monthly price. Database and file storage do
        not add to it. Billing also shows a <strong>Project costs</strong> table: a running{" "}
        <strong>estimate</strong> of what each project&apos;s usage would cost at standard rates (compute by
        the hour, storage per GB-month, egress per GB). It is information, not an invoice, and nothing in
        it is charged on top of the plan. The standard rates are public at{" "}
        <code>GET /api/billing/rates</code> and on the pricing section of the home page. On Free the plan
        costs $0, so none of it is charged.
      </p>

      <h2>What happens at a limit</h2>
      <table>
        <thead>
          <tr><th>Resource</th><th>At the limit</th></tr>
        </thead>
        <tbody>
          <tr><td>Projects</td><td>Creating another project is refused until you delete or deactivate one, or upgrade.</td></tr>
          <tr><td>Team members</td><td>Inviting another member is refused.</td></tr>
          <tr>
            <td>File storage</td>
            <td>
              An upload that would take the organization over its limit is refused (HTTP <code>402</code>,{" "}
              <code>Quota Exceeded</code>) until you delete files or upgrade.
            </td>
          </tr>
          <tr>
            <td>Database size</td>
            <td>
              A move to a plan whose limit your databases exceed is blocked until you delete data. Growth
              past the limit follows the rollout mode below.
            </td>
          </tr>
          <tr>
            <td>API requests, egress, monthly active users, database size</td>
            <td>Follow the rollout mode of each limit, below.</td>
          </tr>
        </tbody>
      </table>

      <h3>API requests, egress, monthly active users and database size</h3>
      <p>
        Each of these four limits has a rollout mode, set by the operator for the whole platform and shown
        on the Billing page next to each figure:
      </p>
      <ul>
        <li>
          <strong>warn</strong> (the default today): nothing is refused. Usage is counted and shown against
          the limit; the platform logs which organizations would be refused.
        </li>
        <li>
          <strong>enforce</strong>: the owners of the organization are mailed once a month at{" "}
          <strong>80%</strong> and at <strong>100%</strong> of the limit, and Billing shows a notice. Past the
          limit plus a <strong>10% grace</strong>, the request is refused (table below).
        </li>
        <li>
          <strong>off</strong>: the limit is not evaluated.
        </li>
      </ul>
      <table>
        <thead>
          <tr><th>Limit (enforce, past the grace)</th><th>What is refused</th><th>Answer</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>API requests per month</td>
            <td>Every request that names a project, until the counter resets on the 1st (UTC) or you upgrade.</td>
            <td><code>429</code>, <code>Retry-After</code> until the 1st</td>
          </tr>
          <tr>
            <td>Egress per month</td>
            <td>The same.</td>
            <td><code>429</code>, <code>Retry-After</code> until the 1st</td>
          </tr>
          <tr>
            <td>Monthly active users</td>
            <td>
              <strong>New sign-ups</strong> of your projects&apos; end users (email/password sign-up, anonymous
              sign-in). Existing users keep signing in and refreshing their sessions.
            </td>
            <td><code>402</code></td>
          </tr>
          <tr>
            <td>Database size</td>
            <td>
              Writes that add data through the API: inserts and updates over <code>/rest/v1</code> and
              collections, the table editor, imports, and SQL scripts with <code>INSERT</code>,{" "}
              <code>UPDATE</code>, <code>MERGE</code>, <code>CREATE</code>, <code>ALTER</code> or{" "}
              <code>COPY</code>. Reading, <code>DELETE</code>, <code>TRUNCATE</code>, <code>DROP</code> and{" "}
              <code>VACUUM</code> keep working, so you can always free space.
            </td>
            <td><code>402</code></td>
          </tr>
        </tbody>
      </table>
      <p>
        A refusal is JSON with <code>code: &quot;plan_limit_exceeded&quot;</code>, the <code>resource</code>,
        the <code>current</code> and <code>limit</code> figures, a <code>message</code> and an{" "}
        <code>upgradeUrl</code>. Upgrading lifts it within a minute.
      </p>
      <p>
        Never refused, in any mode: health checks, the Billing and payment routes (you can always pay and
        upgrade), the dashboard itself (only its writes that add data fall under the database-size limit), and the project sign-in and session-refresh routes. Legacy plans,
        Enterprise limits left empty, and a monthly figure that still belongs to the previous month are
        never enforced.
      </p>
      <p>
        What the database-size limit cannot stop: connections straight to PostgreSQL through the connection
        pooler (<code>db.basefyio.com:6432</code>) do not pass through the API, so writes made that way are
        not refused; they still count toward the size, which is measured every hour. Database functions
        called over <code>/rest/v1/rpc</code> and a <code>SELECT</code> that calls a function which writes
        are not refused either. First sign-ins through an external identity provider (OAuth) are not counted
        as sign-ups for the MAU limit.
      </p>

      <h2>How often usage is measured</h2>
      <table>
        <thead>
          <tr><th>Figure</th><th>Measured</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Database size</td>
            <td>
              From PostgreSQL&apos;s own size of the database, every hour for every project. The Overview also
              re-measures when the stored value is older than one hour.
            </td>
          </tr>
          <tr>
            <td>File storage</td>
            <td>
              Every six hours, and right after an import. Uploads are checked against the last measured
              total, so a limit can be passed by a little before the next measurement.
            </td>
          </tr>
          <tr>
            <td>API requests and egress</td>
            <td>
              Every request that names a project (its API key or <code>x-project-id</code>) through the API, on
              every path the SDKs use (<code>/rest/v1</code>, <code>/auth/v1</code>, <code>/storage/v1</code>,{" "}
              <code>/realtime/v1</code>); egress is the response bytes only (uploads and other request bodies are not counted). Counted continuously,
              written to the database every few hours; reset on the first of each month (UTC).
            </td>
          </tr>
          <tr>
            <td>Monthly active users</td>
            <td>
              Distinct end users of the organization&apos;s projects who signed in, refreshed a session or called
              the API with their user token during the calendar month (UTC); anonymous sign-ins count too.
              Updated every hour; reset on the first of each month.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Over the API</h2>
      <p>
        <code>GET /api/projects/&#123;id&#125;/resources</code> (dashboard session only) returns what the
        Overview card shows: <code>region</code>, <code>compute</code> (<code>mode</code>:{" "}
        <code>shared</code> or <code>dedicated</code>, with <code>vcpu</code> and <code>memoryGb</code> for a
        dedicated container), <code>plan</code>, <code>uncapped</code>, and <code>database</code> and{" "}
        <code>storage</code>, each with <code>projectBytes</code>, <code>organizationBytes</code>,{" "}
        <code>limitBytes</code> (<code>null</code> = no cap) and <code>measuredAt</code>.
      </p>
    </div>
  );
}
