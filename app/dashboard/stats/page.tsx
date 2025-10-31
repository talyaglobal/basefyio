import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DefaultStatsGrid, StatsOverview } from "@/components/stats-overview"

export default function StatsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Stats</h1>
        <p className="text-muted-foreground mt-1">Usage and performance metrics</p>
      </div>

      <StatsOverview
        render={(stats, { isLoading, error }) => (
          <div className="space-y-4">
            <DefaultStatsGrid stats={stats} isLoading={isLoading} />
            {error && <div className="text-sm text-red-600">{error}</div>}
          </div>
        )}
      />
    </div>
  )
}


