"use client"

import { useQuery } from "@tanstack/react-query"

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

type StatsResponse = {
  tables: number
  rows: number
  storage: number
  apiKeys: number
}

export function StatsOverview({
  render,
}: {
  render: (stats: StatsResponse | null, state: { isLoading: boolean; error: string | null }) => React.ReactNode
}) {
  const { data, isLoading, isError, error } = useQuery<StatsResponse>({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/stats")
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to load stats")
      return json as StatsResponse
    },
  })

  const err = isError ? (error as Error).message : null
  return <>{render(data ?? null, { isLoading, error: err })}</>
}

export const DefaultStatsGrid = ({ stats, isLoading }: { stats: StatsResponse | null; isLoading: boolean }) => {
  const cells = [
    { title: "Tables", desc: "Count", value: stats?.tables?.toLocaleString() ?? "—" },
    { title: "Rows", desc: "Total", value: stats?.rows?.toLocaleString() ?? "—" },
    { title: "Storage", desc: "Database size", value: stats ? formatBytes(stats.storage) : "—" },
    { title: "API Keys", desc: "Count", value: stats?.apiKeys?.toString() ?? "—" },
  ]
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 opacity-100">
      {cells.map((c) => (
        <div key={c.title} className="border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">{c.title}</div>
          <div className="text-2xl font-semibold">{isLoading ? "…" : c.value}</div>
          <div className="text-xs text-muted-foreground">{c.desc}</div>
        </div>
      ))}
    </div>
  )
}


