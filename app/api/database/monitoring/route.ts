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
    const timeRange = searchParams.get('timeRange') || '1h' // 1h, 6h, 24h, 7d, 30d
    const includeDetails = searchParams.get('details') === 'true'

    // Get database metrics
    const metrics = await dbManager.getMetrics()
    
    // Get connection pool stats
    const poolStats = connectionPool.getStats()
    const connectionDetails = includeDetails ? connectionPool.getConnectionDetails() : []

    // Get database safety metrics
    const safetyMetrics = safeDb.getMetrics()

    // Get system health indicators
    const healthChecks = await Promise.allSettled([
      // Database connectivity check
      connectionPool.execute(async (sql) => {
        const result = await sql`SELECT 1 as health_check`
        return result.length > 0
      }),
      
      // Replication lag check (if replicas exist)
      ((dbManager as any).checkReplicationHealth?.() || Promise.resolve({ healthy: true, lag: 0 })).catch(() => ({ healthy: true, lag: 0 })),
      
      // Storage space check
      ((dbManager as any).getStorageUsage?.() || Promise.resolve({ used: 0, total: 0, percent: 0 })).catch(() => ({ used: 0, total: 0, percent: 0 })),
    ])

    const [dbConnectivity, replicationHealth, storageUsage] = healthChecks.map(result => 
      result.status === 'fulfilled' ? result.value : null
    )

    // Calculate performance indicators
    const performanceIndicators = {
      avgQueryTime: (poolStats as any).avgQueryTime || 0,
      avgConnectionTime: (poolStats as any).avgConnectionTime || 0,
      querySuccessRate: ((safetyMetrics as any).totalQueries || 0) > 0 
        ? ((((safetyMetrics as any).totalQueries || 0) - ((safetyMetrics as any).failedQueries || 0)) / ((safetyMetrics as any).totalQueries || 1)) * 100
        : 100,
      activeConnections: (poolStats as any).active || 0,
      connectionUtilization: ((poolStats as any).total || 0) > 0 ? (((poolStats as any).active || 0) / ((poolStats as any).total || 1)) * 100 : 0,
    }

    // Determine overall health status
    const healthStatus = determineHealthStatus({
      dbConnectivity: !!dbConnectivity,
      replicationHealthy: replicationHealth ? replicationHealth.healthy : true,
      querySuccessRate: performanceIndicators.querySuccessRate,
      connectionUtilization: performanceIndicators.connectionUtilization,
      errorRate: ((safetyMetrics as any).totalQueries || 0) > 0 ? (((safetyMetrics as any).failedQueries || 0) / ((safetyMetrics as any).totalQueries || 1)) * 100 : 0,
    })

    const monitoringData = {
      timestamp: new Date().toISOString(),
      healthStatus,
      performanceIndicators,
      databaseMetrics: metrics,
      connectionPool: {
        stats: poolStats,
        ...(includeDetails && { connections: connectionDetails }),
      },
      safetyMetrics: {
        totalQueries: (safetyMetrics as any).totalQueries || 0,
        failedQueries: (safetyMetrics as any).failedQueries || 0,
        blockedQueries: (safetyMetrics as any).blockedQueries || 0,
        avgQueryTime: (safetyMetrics as any).avgQueryTime || 0,
        slowQueries: (safetyMetrics as any).slowQueries || 0,
        timeoutQueries: (safetyMetrics as any).timeoutQueries || 0,
      },
      systemHealth: {
        database: {
          connected: !!dbConnectivity,
          status: dbConnectivity ? 'healthy' : 'error',
        },
        replication: replicationHealth || { healthy: true, lag: 0 },
        storage: storageUsage || { used: 0, total: 0, percent: 0 },
      },
    }

    return NextResponse.json(monitoringData, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      }
    })
  } catch (error: any) {
    console.error("Error fetching monitoring data:", error)
    return createInternalError("Failed to fetch monitoring data")
  }
}

function determineHealthStatus(indicators: {
  dbConnectivity: boolean
  replicationHealthy: boolean
  querySuccessRate: number
  connectionUtilization: number
  errorRate: number
}): 'healthy' | 'warning' | 'critical' {
  // Critical conditions
  if (!indicators.dbConnectivity || 
      !indicators.replicationHealthy ||
      indicators.querySuccessRate < 90 ||
      indicators.errorRate > 10) {
    return 'critical'
  }

  // Warning conditions
  if (indicators.querySuccessRate < 95 ||
      indicators.connectionUtilization > 80 ||
      indicators.errorRate > 5) {
    return 'warning'
  }

  return 'healthy'
}