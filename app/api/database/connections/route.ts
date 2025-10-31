import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { connectionPool } from "@/lib/connection-pool"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Get connection pool statistics and details
    const stats = connectionPool.getStats()
    const connections = connectionPool.getConnectionDetails()

    // Calculate additional metrics
    const now = Date.now()
    const activeConnections = connections.filter(conn => conn.inUse)
    const idleConnections = connections.filter(conn => !conn.inUse)
    
    const connectionAges = connections.map(conn => 
      now - conn.createdAt.getTime()
    )
    
    const avgConnectionAge = connectionAges.length > 0 
      ? connectionAges.reduce((a, b) => a + b, 0) / connectionAges.length 
      : 0

    const connectionUtilization = connections.map(conn => ({
      id: conn.id,
      utilization: conn.queries > 0 ? (conn.queries / (conn.queries + 1)) * 100 : 0,
      errorRate: conn.queries > 0 ? (conn.errors / conn.queries) * 100 : 0,
      age: now - conn.createdAt.getTime(),
      lastUsed: now - conn.lastUsed.getTime(),
    }))

    const healthMetrics = {
      totalConnections: stats.total,
      activeConnections: stats.active,
      idleConnections: stats.idle,
      waitingRequests: stats.waiting,
      connectionErrors: stats.errors,
      avgConnectionTime: stats.avgConnectionTime,
      avgQueryTime: stats.avgQueryTime,
      avgConnectionAge: avgConnectionAge,
      connectionUtilization: (stats.active / stats.total) * 100,
      errorRate: stats.total > 0 ? (stats.errors / stats.total) * 100 : 0,
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      stats: healthMetrics,
      connections: connections.map(conn => ({
        id: conn.id,
        createdAt: conn.createdAt.toISOString(),
        lastUsed: conn.lastUsed.toISOString(),
        inUse: conn.inUse,
        queries: conn.queries,
        errors: conn.errors,
        isReadReplica: conn.isReadReplica,
        age: now - conn.createdAt.getTime(),
        idleTime: now - conn.lastUsed.getTime(),
        errorRate: conn.queries > 0 ? (conn.errors / conn.queries) * 100 : 0,
      })),
      utilization: connectionUtilization,
      recommendations: generateConnectionRecommendations(healthMetrics, connectionUtilization),
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      }
    })
  } catch (error: any) {
    console.error("Error fetching connection monitoring data:", error)
    return createInternalError("Failed to fetch connection monitoring data")
  }
}

function generateConnectionRecommendations(
  healthMetrics: any, 
  connectionUtilization: any[]
): Array<{
  type: 'info' | 'warning' | 'error'
  message: string
  action?: string
}> {
  const recommendations = []

  // High utilization warning
  if (healthMetrics.connectionUtilization > 80) {
    recommendations.push({
      type: 'warning' as const,
      message: `Connection utilization is high (${healthMetrics.connectionUtilization.toFixed(1)}%)`,
      action: 'Consider increasing the maximum connection pool size',
    })
  }

  // Too many waiting requests
  if (healthMetrics.waitingRequests > 5) {
    recommendations.push({
      type: 'error' as const,
      message: `${healthMetrics.waitingRequests} requests are waiting for connections`,
      action: 'Increase connection pool size or optimize query performance',
    })
  }

  // High error rate
  if (healthMetrics.errorRate > 5) {
    recommendations.push({
      type: 'error' as const,
      message: `High connection error rate (${healthMetrics.errorRate.toFixed(1)}%)`,
      action: 'Check database connectivity and query patterns',
    })
  }

  // Slow connection acquisition
  if (healthMetrics.avgConnectionTime > 1000) {
    recommendations.push({
      type: 'warning' as const,
      message: `Slow connection acquisition (${healthMetrics.avgConnectionTime.toFixed(0)}ms avg)`,
      action: 'Consider increasing minimum connections or check network latency',
    })
  }

  // Long-running queries
  if (healthMetrics.avgQueryTime > 5000) {
    recommendations.push({
      type: 'warning' as const,
      message: `Slow average query time (${healthMetrics.avgQueryTime.toFixed(0)}ms)`,
      action: 'Optimize queries or add database indexes',
    })
  }

  // Underutilized connections
  const underutilized = connectionUtilization.filter(conn => 
    conn.age > 300000 && conn.lastUsed > 60000 // Older than 5 min, unused for 1 min
  ).length

  if (underutilized > 2) {
    recommendations.push({
      type: 'info' as const,
      message: `${underutilized} connections are underutilized`,
      action: 'Connection pool will automatically clean up idle connections',
    })
  }

  // Everything looks good
  if (recommendations.length === 0) {
    recommendations.push({
      type: 'info' as const,
      message: 'Connection pool is operating normally',
    })
  }

  return recommendations
}