"use client"

import { useQuery } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"

type ActivityItem = {
  id: string | number
  action: string
  description?: string
  user?: string
  created_at: string
}

export function ActivityFeed() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<{ activity: ActivityItem[] }>({
    queryKey: ["dashboard-activity"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/activity")
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Failed to load activity")
      return json
    },
  })

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading recent activity…</div>
  }

  if (isError) {
    return (
      <div className="text-sm text-red-600">
        {(error as Error).message || "Failed to load activity"}
        <button className="ml-2 underline" onClick={() => refetch()} disabled={isFetching}>
          Retry
        </button>
      </div>
    )
  }

  const items = data?.activity ?? []
  if (items.length === 0) {
    return <div className="text-sm text-muted-foreground">No activity yet. Actions will appear here.</div>
  }

  return (
    <ul className="space-y-3">
      {items.map((evt) => (
        <li key={evt.id} className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">{evt.action}</div>
            {evt.description && <div className="text-sm text-muted-foreground">{evt.description}</div>}
            {evt.user && <div className="text-xs text-muted-foreground mt-1">by {evt.user}</div>}
          </div>
          <div className="text-xs text-muted-foreground whitespace-nowrap">
            {formatDistanceToNow(new Date(evt.created_at), { addSuffix: true })}
          </div>
        </li>
      ))}
    </ul>
  )
}


