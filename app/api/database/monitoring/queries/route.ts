import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
    const onlyErrors = searchParams.get('errors') === 'true'
    const onlySlow = searchParams.get('slow') === 'true'

    // Get query logs from the safety wrapper
    const metrics = safeDb.getMetrics()
    // Query history is not available in current implementation
    const queryLogs: any[] = []

    // Filter based on parameters
    let filteredLogs = queryLogs
    
    if (onlyErrors) {
      filteredLogs = filteredLogs.filter(log => log.error)
    }
    
    if (onlySlow) {
      filteredLogs = filteredLogs.filter(log => log.duration > 1000) // > 1 second
    }

    // Get recent query statistics
    const recentStats = {
      totalQueries: (metrics as any).totalQueries || 0,
      failedQueries: (metrics as any).failedQueries || 0,
      blockedQueries: (metrics as any).blockedQueries || 0,
      avgQueryTime: (metrics as any).avgQueryTime || 0,
      slowQueries: (metrics as any).slowQueries || 0,
      timeoutQueries: (metrics as any).timeoutQueries || 0,
    }

    // Get top slow queries (aggregated)
    const slowQueryAggregates = aggregateSlowQueries(queryLogs)

    // Get error frequency by type
    const errorFrequency = aggregateErrors(queryLogs)

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      statistics: recentStats,
      queryLogs: filteredLogs.map(log => ({
        timestamp: log.timestamp.toISOString(),
        query: log.query.substring(0, 200) + (log.query.length > 200 ? '...' : ''), // Truncate for privacy
        duration: log.duration,
        success: !log.error,
        error: log.error,
        blocked: log.blocked,
      })),
      slowQueries: slowQueryAggregates,
      errorFrequency,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      }
    })
  } catch (error: any) {
    console.error("Error fetching query monitoring data:", error)
    return createInternalError("Failed to fetch query monitoring data")
  }
}

function aggregateSlowQueries(queryLogs: any[]): Array<{
  queryPattern: string
  avgDuration: number
  maxDuration: number
  count: number
}> {
  const patterns = new Map()

  queryLogs
    .filter(log => log.duration > 1000) // Only slow queries
    .forEach(log => {
      // Create a pattern by removing specific values
      const pattern = log.query
        .replace(/\$\d+/g, '$?') // Replace parameters
        .replace(/\d+/g, '?') // Replace numbers
        .replace(/'[^']*'/g, "'?'") // Replace string literals
        .substring(0, 100) + '...'

      if (!patterns.has(pattern)) {
        patterns.set(pattern, {
          queryPattern: pattern,
          durations: [],
          count: 0,
        })
      }

      const entry = patterns.get(pattern)
      entry.durations.push(log.duration)
      entry.count++
    })

  return Array.from(patterns.values())
    .map(entry => ({
      queryPattern: entry.queryPattern,
      avgDuration: entry.durations.reduce((a: number, b: number) => a + b, 0) / entry.durations.length,
      maxDuration: Math.max(...entry.durations),
      count: entry.count,
    }))
    .sort((a, b) => b.avgDuration - a.avgDuration)
    .slice(0, 10) // Top 10
}

function aggregateErrors(queryLogs: any[]): Array<{
  errorType: string
  count: number
  lastSeen: string
}> {
  const errors = new Map()

  queryLogs
    .filter(log => log.error)
    .forEach(log => {
      // Extract error type from message
      const errorType = log.error.split(':')[0] || 'Unknown Error'
      
      if (!errors.has(errorType)) {
        errors.set(errorType, {
          errorType,
          count: 0,
          lastSeen: log.timestamp,
        })
      }

      const entry = errors.get(errorType)
      entry.count++
      if (log.timestamp > entry.lastSeen) {
        entry.lastSeen = log.timestamp
      }
    })

  return Array.from(errors.values())
    .map(entry => ({
      ...entry,
      lastSeen: entry.lastSeen.toISOString(),
    }))
    .sort((a, b) => b.count - a.count)
}