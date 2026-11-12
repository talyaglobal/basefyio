import { getBillingPlansFetchEndpoints } from "@/lib/site-url";

/** A plan as `GET /api/billing/plans` returns it (the fields the site shows). */
export type PublicPlan = {
  id: string;
  name: string;
  displayName: string;
  priceMonthly: number;
  maxProjects: number | null;
  maxStorageBytes: number | string | null;
  maxDbSizeBytes: number | string | null;
  maxTeamMembers: number | null;
  maxApiRequests: number | null;
  maxBandwidthBytes: number | string | null;
  maxMau?: number | null;
  dedicatedDb: boolean;
  dedicatedStorage: boolean;
  isPublic: boolean;
};

function numOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatBytes(v: number | string | null | undefined): string {
  const n = numOrNull(v);
  if (n === null || n <= 0) return "Unlimited";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = n;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  const fixed = size >= 10 ? size.toFixed(0) : size.toFixed(1);
  return `${fixed} ${units[i]}`;
}

/** 50000 → "50K", 1000000 → "1M"; null or ≤ 0 means no limit. */
export function formatCount(v: number | null | undefined): string {
  if (v === null || v === undefined || v <= 0) return "Unlimited";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}K`;
  return String(v);
}

/** The limit lines on a plan card, in the order the dashboard's Billing page lists them. */
export function planFeatures(plan: PublicPlan): string[] {
  return [
    `${plan.maxProjects ?? "Unlimited"} projects`,
    `${formatBytes(plan.maxStorageBytes)} storage`,
    `${formatBytes(plan.maxDbSizeBytes)} database`,
    `${plan.maxTeamMembers ?? "Unlimited"} team members`,
    `${formatCount(plan.maxApiRequests)} API requests/mo`,
    `${formatBytes(plan.maxBandwidthBytes)} bandwidth/mo`,
    // An API that predates the field leaves it out; say nothing rather than "Unlimited".
    ...(plan.maxMau === undefined ? [] : [`${formatCount(plan.maxMau)} monthly active users`]),
    plan.dedicatedDb || plan.dedicatedStorage ? "Dedicated infrastructure" : "Shared infrastructure",
  ];
}

/** Public plans from the API, cheapest first; empty when no endpoint answers. */
export async function getPublicPlans(): Promise<PublicPlan[]> {
  for (const url of getBillingPlansFetchEndpoints()) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const data = (await res.json()) as PublicPlan[];
      if (Array.isArray(data) && data.length > 0) {
        return data.filter((p) => p.isPublic).sort((a, b) => a.priceMonthly - b.priceMonthly);
      }
    } catch {
      // Try the next endpoint.
    }
  }
  return [];
}
