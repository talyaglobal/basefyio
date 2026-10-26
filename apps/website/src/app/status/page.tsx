import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleHelp, Mail, XCircle } from "lucide-react";
import { BasefyioLogo } from "@/components/basefyio-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { getPublicApiUrl, getSiteUrl } from "@/lib/site-url";
import { statusUrl } from "@/lib/public-hosts";
import { getStatusFetchEndpoints } from "@/lib/status-endpoints";
import type {
  ComponentState,
  ComponentStatus,
  DayFigure,
  IncidentView,
  MonthComponent,
  PublicStatus,
  StatusHistory,
  TrackedComponent,
} from "@/lib/status-types";
import { SubscribeUpdates } from "./subscribe-form";

const TITLE = "basefyio status";
const DESCRIPTION =
  "Live availability of the basefyio platform: API, dashboard, auth, database endpoint, storage and realtime, measured every 30 seconds, with monthly history and incidents.";
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@talyasmart.com";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const url = statusUrl();
  return {
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: { canonical: url },
    openGraph: { title: TITLE, description: DESCRIPTION, url, type: "website" },
    twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
    robots: { index: true, follow: true },
  };
}

/**
 * The last good payloads, kept in the server process for two days so the
 * page shows the last known state when the API cannot be reached, instead
 * of an error — a status page that is down with the platform tells nobody
 * anything.
 */
const SNAPSHOT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const snapshots = new Map<string, { at: number; data: unknown }>();

async function loadJson<T>(path: string, accept: (v: T) => boolean): Promise<{ data: T | null; fromSnapshot: boolean }> {
  for (const url of getStatusFetchEndpoints(path)) {
    try {
      const res = await fetch(url, {
        next: { revalidate: 30 },
        headers: { "User-Agent": "basefyio-website/1.0 (+status page)" },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as T;
      if (!data || !accept(data)) continue;
      snapshots.set(path, { at: Date.now(), data });
      return { data, fromSnapshot: false };
    } catch {
      continue;
    }
  }
  const snap = snapshots.get(path);
  if (snap && Date.now() - snap.at < SNAPSHOT_MAX_AGE_MS) return { data: snap.data as T, fromSnapshot: true };
  return { data: null, fromSnapshot: false };
}

// ── Presentation helpers ───────────────────────────────────────────────────

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

const OVERALL: Record<ComponentState, { title: string; text: string; tone: string; Icon: typeof CheckCircle2 }> = {
  operational: {
    title: "All systems operational",
    text: "Every indicator passed its latest check.",
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
    Icon: CheckCircle2,
  },
  degraded: {
    title: "Some systems are degraded",
    text: "A check failed in the last few minutes, or an incident is open. Details below.",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
    Icon: AlertTriangle,
  },
  down: {
    title: "Service disruption",
    text: "At least one indicator is down right now. Follow the open incident below.",
    tone: "border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-200",
    Icon: XCircle,
  },
  unknown: {
    title: "No measurements yet",
    text: "No probe has reported in the last five minutes; the figures below are the last ones recorded.",
    tone: "border-border bg-muted/30",
    Icon: CircleHelp,
  },
};

function pct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(v >= 99.99 ? 3 : 2)} %`;
}

function dayClass(d: DayFigure): string {
  if (d.future) return "bg-transparent border border-dashed border-border";
  if (d.availabilityPct === null) return "bg-muted-foreground/15";
  if (d.availabilityPct >= 99.9) return "bg-emerald-500";
  if (d.availabilityPct >= 99) return "bg-amber-400";
  return "bg-red-500";
}

function dayTitle(d: DayFigure): string {
  if (d.future) return `${d.day}: not yet`;
  if (d.availabilityPct === null) return `${d.day}: no measurements`;
  return `${d.day}: ${d.availabilityPct} % · ${d.downMinutes} min down of ${d.totalMinutes} observed`;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });
}

function durationLabel(startIso: string, endIso: string | null): string {
  const ms = (endIso ? new Date(endIso).getTime() : Date.now()) - new Date(startIso).getTime();
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function DayBars({ days, label }: { days: DayFigure[]; label: string }) {
  return (
    <div className="mt-3 flex h-5 gap-[2px]" role="img" aria-label={`${label}: one square per day`}>
      {days.map((d) => (
        <span key={d.day} className={`min-w-0 flex-1 rounded-[2px] ${dayClass(d)}`} title={dayTitle(d)} />
      ))}
    </div>
  );
}

function CoversList({ items, noun }: { items: string[]; noun: string }) {
  if (items.length === 0) return null;
  return (
    <details className="group inline-block">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
        {items.length} {noun}
        {items.length === 1 ? "" : "s"} <span aria-hidden="true">›</span>
      </summary>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {items.map((c) => (
          <li key={c} className="flex gap-2">
            <span aria-hidden="true">·</span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function MetBadge({ met, targetPct }: { met: boolean | null; targetPct: number }) {
  if (met === null) return <span className="text-xs text-muted-foreground">target {targetPct} %</span>;
  return met ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> met {targetPct} %
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
      <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> missed {targetPct} %
    </span>
  );
}

function ProbeRow({ live, month }: { live: ComponentStatus; month: MonthComponent | undefined }) {
  const days = month?.days ?? live.days;
  const availability = month ? month.availabilityPct : live.month.availabilityPct;
  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATE_DOT[live.state]}`} aria-hidden="true" />
          <span className="font-medium">{live.label}</span>
          <CoversList items={live.covers} noun="check" />
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{STATE_LABEL[live.state]}</span>
          <span className="font-medium tabular-nums">{pct(availability)}</span>
        </div>
      </div>
      <DayBars days={days} label={live.label} />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{days[0]?.day}</span>
        <span className="flex flex-wrap items-center gap-x-3">
          {month && <MetBadge met={month.met} targetPct={month.targetPct} />}
          <span>90 days {pct(live.last90d.availabilityPct)}</span>
          {live.latencyMs !== null && <span>{live.latencyMs} ms</span>}
        </span>
        <span>{days[days.length - 1]?.day}</span>
      </div>
    </li>
  );
}

function TrackedRow({ t }: { t: TrackedComponent }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATE_DOT[t.state]}`} aria-hidden="true" />
        <span className="font-medium">{t.label}</span>
        <CoversList items={t.covers} noun="area" />
      </div>
      <span className="text-sm text-muted-foreground">{STATE_LABEL[t.state]}</span>
    </li>
  );
}

function IncidentCard({ i, labels }: { i: IncidentView; labels: Record<string, string> }) {
  const tone = i.excludedFromSlo
    ? "border-sky-500/40"
    : i.status === "RESOLVED"
      ? "border-border"
      : i.impact === "CRITICAL" || i.impact === "MAJOR"
        ? "border-red-500/50"
        : "border-amber-500/50";
  return (
    <li className={`rounded-xl border bg-card p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-medium">{i.title}</h3>
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
          {i.excludedFromSlo ? "Maintenance" : i.status.charAt(0) + i.status.slice(1).toLowerCase()}
          {i.impact !== "NONE" && !i.excludedFromSlo && <> · {i.impact.toLowerCase()} impact</>}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {fmtDateTime(i.startedAt)}
        {i.resolvedAt ? <> → {fmtDateTime(i.resolvedAt)} · {durationLabel(i.startedAt, i.resolvedAt)}</> : <> · ongoing for {durationLabel(i.startedAt, null)}</>}
        {i.components.length > 0 && <> · {i.components.map((c) => labels[c] ?? c).join(", ")}</>}
        {i.auto && <> · opened by the probes</>}
      </p>
      {i.updates.length > 0 && (
        <ol className="mt-3 space-y-2 border-l pl-3 text-sm">
          {i.updates
            .slice()
            .reverse()
            .map((u) => (
              <li key={u.ts}>
                <span className="text-xs text-muted-foreground">
                  {fmtDateTime(u.ts)} · {u.status.toLowerCase()}
                </span>
                {u.text && <p>{u.text}</p>}
              </li>
            ))}
        </ol>
      )}
      {i.postmortem && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Post-mortem</p>
          <p className="mt-1 whitespace-pre-line">{i.postmortem}</p>
        </div>
      )}
    </li>
  );
}

function MonthNav({ history, current }: { history: StatusHistory; current: boolean }) {
  const link = (key: string | null, Icon: typeof ChevronLeft, label: string) =>
    key ? (
      <Link href={`?month=${key}`} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={label} title={monthLabel(key)}>
        <Icon className="h-4 w-4" />
      </Link>
    ) : (
      <span className="p-1 text-muted-foreground/30" aria-hidden="true">
        <Icon className="h-4 w-4" />
      </span>
    );
  return (
    <div className="flex items-center gap-1 text-sm">
      {link(history.prevMonth, ChevronLeft, "Previous month")}
      <span className="min-w-[9rem] text-center font-medium">{monthLabel(history.month)}</span>
      {link(history.nextMonth, ChevronRight, "Next month")}
      {!current && (
        <Link href="?" className="ml-2 text-xs text-muted-foreground underline-offset-2 hover:underline">
          This month
        </Link>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

type Search = { month?: string; subscribed?: string; unsubscribed?: string };

export default async function StatusPage({ searchParams }: { searchParams: Search }) {
  const wanted = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? (searchParams.month as string) : null;
  const [pub, hist] = await Promise.all([
    loadJson<PublicStatus>("public", (v) => Array.isArray(v.components)),
    loadJson<StatusHistory>(wanted ? `history?month=${wanted}` : "history", (v) => Array.isArray(v.components)),
  ]);
  const data = pub.data;
  const history = hist.data;
  const overall: ComponentState = data ? (data.live ? data.overall : "unknown") : "unknown";
  const copy = OVERALL[overall];
  const Icon = copy.Icon;
  const currentMonth = !wanted || (history !== null && history.nextMonth === null);
  const labels: Record<string, string> = {};
  for (const c of data?.components ?? []) labels[c.probe] = c.label;
  for (const t of data?.tracked ?? []) labels[t.id] = t.label;
  const monthIncidents = history?.incidents ?? [];
  const notice =
    searchParams.subscribed === "1"
      ? { tone: "ok", text: "Subscription confirmed. You will hear about incidents as they open, change and resolve." }
      : searchParams.subscribed === "0"
        ? { tone: "error", text: "That confirmation link is not valid any more. Subscribe again to get a fresh one." }
        : searchParams.unsubscribed === "1"
          ? { tone: "ok", text: "Unsubscribed. No more incident mail will be sent to that address." }
          : searchParams.unsubscribed === "0"
            ? { tone: "error", text: "That unsubscribe link is not valid any more." }
            : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/60">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <BasefyioLogo href={getSiteUrl()} />
            <span className="text-sm text-muted-foreground">status</span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <a
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Problem report: basefyio")}`}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              Report a problem
            </a>
            <SubscribeUpdates apiUrl={getPublicApiUrl()} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        {notice && (
          <p
            className={`mb-4 rounded-lg border px-4 py-2 text-sm ${
              notice.tone === "ok" ? "border-emerald-500/40 bg-emerald-500/10" : "border-red-500/40 bg-red-500/10"
            }`}
            role="status"
          >
            {notice.text}
          </p>
        )}

        <section className={`rounded-xl border ${copy.tone}`} aria-live="polite">
          <div className="flex items-center gap-3 px-5 py-4">
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <h1 className="text-lg font-semibold">{copy.title}</h1>
          </div>
          <div className="border-t border-inherit px-5 py-3 text-sm">
            <p>{copy.text}</p>
            {data && (
              <p className="mt-1 text-xs text-muted-foreground">
                {pub.fromSnapshot ? "Last known state · " : ""}
                updated {fmtDateTime(data.generatedAt)}
                {data.vantages.length > 0 && (
                  <>
                    {" "}
                    · measured every 30 seconds from {data.vantages.length} vantage point{data.vantages.length === 1 ? "" : "s"}
                  </>
                )}
              </p>
            )}
          </div>
        </section>

        {!data ? (
          <p className="mt-8 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            The status data could not be loaded right now. Try again in a minute.
          </p>
        ) : (
          <>
            {data.incidents.open.length > 0 && (
              <section className="mt-8">
                <h2 className="text-base font-semibold">Open incidents</h2>
                <ul className="mt-3 space-y-3">
                  {data.incidents.open.map((i) => (
                    <IncidentCard key={i.id} i={i} labels={labels} />
                  ))}
                </ul>
              </section>
            )}

            {data.maintenance.length > 0 && (
              <section className="mt-8">
                <h2 className="text-base font-semibold">Scheduled maintenance</h2>
                <ul className="mt-3 space-y-3">
                  {data.maintenance.map((i) => (
                    <IncidentCard key={i.id} i={i} labels={labels} />
                  ))}
                </ul>
              </section>
            )}

            <section className="mt-8 rounded-xl border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
                <h2 className="text-base font-semibold">System status</h2>
                {history ? (
                  <MonthNav history={history} current={currentMonth} />
                ) : (
                  <span className="text-xs text-muted-foreground">last 90 days</span>
                )}
              </div>
              <ul className="divide-y">
                {data.components.map((c) => (
                  <ProbeRow key={c.probe} live={c} month={history?.components.find((m) => m.probe === c.probe)} />
                ))}
              </ul>
              {data.tracked.length > 0 && (
                <>
                  <div className="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground sm:px-5">
                    Tracked through incidents: no probe runs against these, so their state is what the team reports.
                  </div>
                  <ul className="divide-y border-t">
                    {data.tracked.map((t) => (
                      <TrackedRow key={t.id} t={t} />
                    ))}
                  </ul>
                </>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground sm:px-5">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-[2px] bg-emerald-500" aria-hidden="true" /> 99.9 % or better
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-[2px] bg-amber-400" aria-hidden="true" /> 99 – 99.9 %
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-[2px] bg-red-500" aria-hidden="true" /> below 99 %
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-[2px] bg-muted-foreground/15" aria-hidden="true" /> no measurements
                </span>
              </div>
            </section>

            {history && (
              <section className="mt-8 rounded-xl border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
                  <h2 className="text-base font-semibold">{monthLabel(history.month)} in numbers</h2>
                  <span className="text-xs text-muted-foreground">{history.closed ? "final" : "month in progress"}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium sm:px-5">Component</th>
                        <th className="px-3 py-2 font-medium">Availability</th>
                        <th className="px-3 py-2 font-medium">Target</th>
                        <th className="px-3 py-2 font-medium">Down</th>
                        <th className="px-3 py-2 font-medium">Incidents</th>
                        <th className="px-3 py-2 font-medium">Worst daily p95</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {history.components.map((m) => (
                        <tr key={m.probe}>
                          <td className="px-4 py-2 font-medium sm:px-5">{m.label}</td>
                          <td className="px-3 py-2 tabular-nums">{pct(m.availabilityPct)}</td>
                          <td className="px-3 py-2">
                            <MetBadge met={m.met} targetPct={m.targetPct} />
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {m.downMinutes} min{m.observedMinutes ? <span className="text-muted-foreground"> / {Math.round(m.observedMinutes / 60)} h observed</span> : null}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{m.incidentCount}</td>
                          <td className="px-3 py-2 tabular-nums">{m.p95LatencyMs === null ? "—" : `${m.p95LatencyMs} ms`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="mt-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">Incident history</h2>
                {history && <span className="text-xs text-muted-foreground">{monthLabel(history.month)}</span>}
              </div>
              {monthIncidents.length === 0 ? (
                <p className="mt-3 rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
                  No incidents reported {history ? `in ${monthLabel(history.month)}` : "this month"}.
                </p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {monthIncidents.map((i) => (
                    <IncidentCard key={i.id} i={i} labels={labels} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <footer className="mt-10 space-y-2 text-xs text-muted-foreground">
          <p>
            Measured every 30 seconds from outside the platform, the way you reach it; a minute counts as down when the majority
            of vantage points fail. Targets per calendar month: 99.97 % for the API, auth and the database endpoint; 99.9 % for the
            dashboard, storage and realtime. Announced maintenance is excluded; deploys are not. Each month is recorded when it
            ends and stays here.
          </p>
          <p>
            Something wrong that this page does not show?{" "}
            <a className="underline underline-offset-2 hover:text-foreground" href={`mailto:${SUPPORT_EMAIL}`}>
              Report a problem
            </a>
            .
          </p>
        </footer>
      </main>
    </div>
  );
}
