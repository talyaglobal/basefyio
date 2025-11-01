"use client"

import { StatsOverview } from "@/components/stats-overview"
import { DatabaseRequired } from "@/components/database-required"

export default function StatsPage() {
  return (
    <DatabaseRequired message="Select or create a database to view statistics.">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Stats</h1>
          <p className="text-muted-foreground mt-1">Usage and performance metrics</p>
        </div>

        <StatsOverview />
      </div>
    </DatabaseRequired>
  )
}


