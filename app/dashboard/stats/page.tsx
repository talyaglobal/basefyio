import { StatsOverview } from "@/components/stats-overview"

// Force dynamic rendering for real-time stats
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function StatsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Stats</h1>
        <p className="text-muted-foreground mt-1">Usage and performance metrics</p>
      </div>

      <StatsOverview />
    </div>
  )
}


