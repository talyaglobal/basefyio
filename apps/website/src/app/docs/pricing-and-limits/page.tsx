import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";

const pageDescription =
  "What a basefyio project gets and what it costs: plan limits for database size and file storage, how storage is billed, compute, region, and what happens at a limit.";

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
          and Business each have a limit for database size and for file storage.
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
        <strong>Limits are per organization</strong>, not per project: the database limit is compared with
        the sum of the sizes of all the organization&apos;s projects, and the file storage limit with all of
        their files. The project Overview shows both numbers.
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
              Shown against the limit; the database is not cut off when it grows past it. A move to a plan
              whose limit your databases exceed is blocked until you delete data.
            </td>
          </tr>
          <tr>
            <td>API requests, egress, monthly active users</td>
            <td>Counted and shown in Billing; not used to block requests at present.</td>
          </tr>
        </tbody>
      </table>

      <h2>How often usage is measured</h2>
      <table>
        <thead>
          <tr><th>Figure</th><th>Measured</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Database size</td>
            <td>
              From PostgreSQL&apos;s own size of the database. The Overview re-measures when the stored value
              is older than one hour; Billing when it is older than six hours.
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
            <td>Counted continuously and written to the database every few hours; reset on the first of each month.</td>
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
