import type { Metadata } from "next";
import { SiteShell } from "@/components/site-shell";
import { buildMetadata } from "@/lib/seo/metadata";
import { getStatusFetchEndpoints } from "@/lib/status-endpoints";
import type { ComponentState, ComponentStatus, IncidentView, PublicStatus } from "@/lib/status-types";

const TITLE = "Status";
const DESCRIPTION =
  "Live availability of the basefyio platform: API, dashboard, auth, database endpoint, storage and realtime, with the last 90 days and open incidents.";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ path: "/status", title: TITLE, description: DESCRIPTION });
}

/**
 * The last good payload, kept in the server process for two days so the page
 * shows the last known state when the API cannot be reached, instead of an
 * error — a status page that is down with the platform tells nobody anything.
 */
const SNAPSHOT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
let snapshot: { at: number; data: PublicStatus } | null = null;

async function loadStatus(): Promise<{ data: PublicStatus | null; fromSnapshot: boolean }> {
  for (const url of getStatusFetchEndpoints()) {
    try {
      const res = await fetch(url, {
        next: { revalidate: 30 },
        headers: { "User-Agent": "basefyio-website/1.0 (+status page)" },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as PublicStatus;
      if (!data || !Array.isArray(data.components)) continue;
      snapshot = { at: Date.now(), data };
      return { data, fromSnapshot: false };
    } catch {
      continue;
    }
  }
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_MAX_AGE_MS) {
    return { data: snapshot.data, fromSnapshot: true };
  }
  return { data: null, fromSnapshot: false };
}

const STATE_LABEL: Record<ComponentState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "No data",
};

const STATE_DOT: Record<ComponentState, string> = {
  operational: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
  unknown: "bg-muted-foreground/40",
};

const OVERALL_COPY: Record<ComponentState, { title: string; tone: string }> = {
  operational: { title: "All systems operational", tone: "border-emerald-500/40 bg-emerald-500/10" },
  degraded: { title: "Some systems are degraded", tone: "border-amber-500/40 bg-amber-500/10" },
  down: { title: "Service disruption", tone: "border-red-500/40 bg-red-500/10" },
  unknown: { title: "No measurements yet", tone: "border-border bg-muted/30" },
};

function pct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(v >= 99.99 ? 3 : 2)} %`;
}

function dayColour(d: { availabilityPct: number | null }): string {
  if (d.availabilityPct === null) return "bg-muted-foreground/20";
  if (d.availabilityPct >= 99.97) return "bg-emerald-500";
  if (d.availabilityPct >= 99) return "bg-amber-500";
  return "bg-red-500";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
}

function ComponentRow({ c }: { c: ComponentStatus }) {
  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${STATE_DOT[c.state]}`} aria-hidden="true" />
          <span className="font-medium">{c.label}</span>
          <span className="text-xs text-muted-foreground">target {c.targetPct} %</span>
        </div>
        <span className="text-sm text-muted-foreground">{STATE_LABEL[c.state]}</span>
      </div>
      <div className="mt-3 flex h-6 gap-[2px]" aria-label={`${c.label}: last 90 days`} role="img">
        {c.days.map((d) => (
          <span
            key={d.day}
            className={`flex-1 rounded-sm ${dayColour(d)}`}
            title={`${d.day}: ${d.availabilityPct === null ? "no data" : `${d.availabilityPct} %, ${d.downMinutes} min down`}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>90 days ago</span>
        <span>
          This month <strong className="text-foreground">{pct(c.month.availabilityPct)}</strong> · Last 90 days{" "}
          <strong className="text-foreground">{pct(c.last90d.availabilityPct)}</strong>
          {c.latencyMs !== null && <> · {c.latencyMs} ms</>}
        </span>
        <span>Today</span>
      </div>
    </li>
  );
}

function Incident({ i }: { i: IncidentView }) {
  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{i.title}</h3>
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
          {i.excludedFromSlo ? "Maintenance" : i.status.charAt(0) + i.status.slice(1).toLowerCase()}
          {i.impact !== "NONE" && !i.excludedFromSlo && <> · {i.impact.toLowerCase()}</>}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {fmtDate(i.startedAt)}
        {i.resolvedAt && <> → {fmtDate(i.resolvedAt)}</>}
        {i.components.length > 0 && <> · {i.components.join(", ")}</>}
      </p>
      {i.updates.length > 0 && (
        <ol className="mt-3 space-y-2 border-l pl-3 text-sm">
          {i.updates
            .slice()
            .reverse()
            .map((u) => (
              <li key={u.ts}>
                <span className="text-xs text-muted-foreground">
                  {fmtDate(u.ts)} · {u.status.toLowerCase()}
                </span>
                <p>{u.text}</p>
              </li>
            ))}
        </ol>
      )}
    </li>
  );
}

export default async function StatusPage() {
  const { data, fromSnapshot } = await loadStatus();
  const overall = data ? (data.live ? data.overall : "unknown") : "unknown";
  const copy = OVERALL_COPY[overall];

  return (
    <SiteShell>
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="text-4xl font-bold tracking-tight">Status</h1>
        <p className="mt-2 text-muted-foreground">
          Measured every 30 seconds from outside the platform, the way you reach it. A minute counts as down when the
          majority of vantage points fail.
        </p>

        <div className={`mt-8 rounded-xl border p-4 ${copy.tone}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">{copy.title}</span>
            {data && (
              <span className="text-xs text-muted-foreground">
                {fromSnapshot ? "Last known state · " : ""}
                updated {fmtDate(data.generatedAt)}
                {data.vantages.length > 0 && <> · {data.vantages.length} vantage point{data.vantages.length === 1 ? "" : "s"}</>}
              </span>
            )}
          </div>
          {data && !data.live && (
            <p className="mt-1 text-xs text-muted-foreground">
              No probe has reported in the last five minutes; the figures below are the last ones recorded.
            </p>
          )}
        </div>

        {!data ? (
          <p className="mt-8 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            The status data could not be loaded right now. Try again in a minute.
          </p>
        ) : (
          <>
            {data.incidents.open.length > 0 && (
              <section className="mt-8">
                <h2 className="text-lg font-semibold">Open incidents</h2>
                <ul className="mt-3 space-y-3">
                  {data.incidents.open.map((i) => (
                    <Incident key={i.id} i={i} />
                  ))}
                </ul>
              </section>
            )}

            {data.maintenance.length > 0 && (
              <section className="mt-8">
                <h2 className="text-lg font-semibold">Scheduled maintenance</h2>
                <ul className="mt-3 space-y-3">
                  {data.maintenance.map((i) => (
                    <Incident key={i.id} i={i} />
                  ))}
                </ul>
              </section>
            )}

            <section className="mt-8">
              <h2 className="text-lg font-semibold">Components</h2>
              <ul className="mt-3 space-y-3">
                {data.components.map((c) => (
                  <ComponentRow key={c.probe} c={c} />
                ))}
              </ul>
            </section>

            <section className="mt-8">
              <h2 className="text-lg font-semibold">Past incidents</h2>
              {data.incidents.recent.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">Nothing in the last 30 days.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {data.incidents.recent.map((i) => (
                    <Incident key={i.id} i={i} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <p className="mt-10 text-xs text-muted-foreground">
          Targets: 99.97 % for the API, auth and the database endpoint; 99.9 % for the dashboard, storage and realtime,
          per calendar month. Announced maintenance is excluded; deploys are not.
        </p>
      </div>
    </SiteShell>
  );
}
