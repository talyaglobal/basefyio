import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { dbManager } from "@/lib/database-manager"
import { connectionPool } from "@/lib/connection-pool"
import { safeDb } from "@/lib/db-safety"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const timeRange = searchParams.get('timeRange') || '1h' // 1h, 6h, 24h, 7d
    const includeHistorical = searchParams.get('historical') === 'true'

    // Get current real-time metrics
    const currentMetrics = await getCurrentMetrics()

    // Get historical metrics if requested
    const historicalData = includeHistorical 
      ? await getHistoricalMetrics(timeRange)
      : null

    const response = {
      timestamp: new Date().toISOString(),
      timeRange,
      current: currentMetrics,
      ...(historicalData && { historical: historicalData }),
    }

    return NextResponse.json(response, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      }
    })
  } catch (error: any) {
    console.error("Error fetching database metrics:", error)
    return createInternalError("Failed to fetch database metrics")
  }
}

async function getCurrentMetrics() {
  const [poolStats, safetyMetrics, dbMetrics] = await Promise.allSettled([
    Promise.resolve(connectionPool.getStats()),
    Promise.resolve(safeDb.getMetrics()),
    dbManager.getMetrics().catch(() => ({})),
  ])

  const pool = poolStats.status === 'fulfilled' ? poolStats.value : {}
  const safety = safetyMetrics.status === 'fulfilled' ? safetyMetrics.value : {}
  const database = dbMetrics.status === 'fulfilled' ? dbMetrics.value : {}

  // Calculate derived metrics
  const poolTotal = (pool as any).total || 0
  const poolActive = (pool as any).active || 0
  const connectionUtilization = poolTotal > 0 ? (poolActive / poolTotal) * 100 : 0
  
  const safetyTotal = (safety as any).totalQueries || 0
  const safetyFailed = (safety as any).failedQueries || 0
  const safetyBlocked = (safety as any).blockedQueries || 0
  
  const querySuccessRate = safetyTotal > 0 
    ? ((safetyTotal - safetyFailed) / safetyTotal) * 100 
    : 100
  const queryBlockRate = safetyTotal > 0 
    ? (safetyBlocked / safetyTotal) * 100 
    : 0

  return {
    connections: {
      total: poolTotal,
      active: poolActive,
      idle: (pool as any).idle || 0,
      waiting: (pool as any).waiting || 0,
      errors: (pool as any).errors || 0,
      utilization: connectionUtilization,
      avgConnectionTime: (pool as any).avgConnectionTime || 0,
    },
    queries: {
      total: safetyTotal,
      successful: safetyTotal - safetyFailed,
      failed: safetyFailed,
      blocked: safetyBlocked,
      slow: (safety as any).slowQueries || 0,
      timeout: (safety as any).timeoutQueries || 0,
      successRate: querySuccessRate,
      blockRate: queryBlockRate,
      avgQueryTime: (safety as any).avgQueryTime || 0,
    },
    performance: {
      avgQueryTime: (pool as any).avgQueryTime || 0,
      avgConnectionTime: (pool as any).avgConnectionTime || 0,
      throughputQPS: calculateThroughput(safetyTotal),
      errorRate: poolTotal > 0 ? ((pool as any).errors || 0) / poolTotal * 100 : 0,
    },
    database: {
      size: (database as any).size || 0,
      tables: (database as any).tables || 0,
      indexes: (database as any).indexes || 0,
      connections: (database as any).activeConnections || 0,
      ...database,
    },
  }
}

async function getHistoricalMetrics(timeRange: string) {
  // This would typically query a metrics storage system
  // For now, we'll return simulated historical data
  const intervals = getIntervalsForTimeRange(timeRange)
  const now = new Date()
  
  const historicalPoints = []
  
  for (let i = intervals; i >= 0; i--) {
    const timestamp = new Date(now.getTime() - (i * getIntervalMs(timeRange)))
    
    // In a real implementation, these would be queried from a time-series database
    const point = {
      timestamp: timestamp.toISOString(),
      connections: {
        active: Math.floor(Math.random() * 10) + 2,
        utilization: Math.floor(Math.random() * 50) + 20,
      },
      queries: {
        qps: Math.floor(Math.random() * 100) + 50,
        avgTime: Math.floor(Math.random() * 500) + 100,
        errorRate: Math.random() * 5,
      },
      performance: {
        responseTime: Math.floor(Math.random() * 200) + 50,
        throughput: Math.floor(Math.random() * 1000) + 500,
      },
    }
    
    historicalPoints.push(point)
  }
  
  return {
    timeRange,
    intervalMs: getIntervalMs(timeRange),
    points: historicalPoints,
  }
}

function getIntervalsForTimeRange(timeRange: string): number {
  switch (timeRange) {
    case '1h': return 60 // 1 minute intervals
    case '6h': return 72 // 5 minute intervals  
    case '24h': return 48 // 30 minute intervals
    case '7d': return 168 // 1 hour intervals
    default: return 60
  }
}

function getIntervalMs(timeRange: string): number {
  switch (timeRange) {
    case '1h': return 60 * 1000 // 1 minute
    case '6h': return 5 * 60 * 1000 // 5 minutes
    case '24h': return 30 * 60 * 1000 // 30 minutes
    case '7d': return 60 * 60 * 1000 // 1 hour
    default: return 60 * 1000
  }
}

function calculateThroughput(totalQueries: number): number {
  // Calculate queries per second based on recent activity
  // This is a simplified calculation - in reality you'd track this over time
  const assumedTimeWindowSeconds = 60
  return totalQueries / assumedTimeWindowSeconds
}