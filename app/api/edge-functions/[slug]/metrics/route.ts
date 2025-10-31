import { NextRequest, NextResponse } from "next/server"
import { requireAuth, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"

export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const sinceParam = searchParams.get('since')
    const since = sinceParam ? new Date(sinceParam) : undefined

    // Get function ID
    const functionResult = await safeDb.safeSelect(`
      SELECT id FROM edge_functions 
      WHERE slug = $1 AND created_by = $2 AND is_active = TRUE
      LIMIT 1
    `, [slug, auth.user.id])

    if (functionResult.rows.length === 0) {
      return NextResponse.json({
        code: "FUNCTION_NOT_FOUND",
        message: "Function not found"
      }, {
        status: 404,
        headers: securityHeaders()
      })
    }

    const functionId = functionResult.rows[0].id

    // Get detailed metrics with dynamic import
    let metrics
    try {
      const { dockerEdgeFunctionRuntime } = await import('@/lib/edge-functions-docker')
      metrics = await dockerEdgeFunctionRuntime.getFunctionMetrics(functionId, since)
    } catch (error) {
      // Fallback metrics calculation
      const metricsResult = await safeDb.safeSelect(`
        SELECT 
          COUNT(*) as total_invocations,
          AVG(execution_time_ms) as avg_execution_time,
          SUM(execution_time_ms) as total_execution_time,
          COUNT(CASE WHEN status = 'success' THEN 1 END) as success_count,
          COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
          COUNT(CASE WHEN status = 'timeout' THEN 1 END) as timeout_count
        FROM edge_function_invocations 
        WHERE function_id = $1 ${since ? 'AND invoked_at >= $2' : ''}
      `, since ? [functionId, since.toISOString()] : [functionId])

      const row = metricsResult.rows[0]
      metrics = {
        totalInvocations: parseInt(row.total_invocations),
        successRate: row.total_invocations > 0 
          ? (row.success_count / row.total_invocations) * 100 
          : 0,
        averageExecutionTime: parseFloat(row.avg_execution_time) || 0,
        totalExecutionTime: parseInt(row.total_execution_time) || 0,
        errorCount: parseInt(row.error_count),
        timeoutCount: parseInt(row.timeout_count)
      }
    }

    // Get recent invocations for trends
    const recentInvocations = await safeDb.safeSelect(`
      SELECT 
        DATE_TRUNC('hour', invoked_at) as hour,
        COUNT(*) as invocations,
        AVG(execution_time_ms) as avg_execution_time,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
        COUNT(CASE WHEN status = 'timeout' THEN 1 END) as timeouts,
        AVG(memory_used_mb) as avg_memory
      FROM edge_function_invocations
      WHERE function_id = $1
        ${since ? 'AND invoked_at >= $2' : ''}
      GROUP BY hour
      ORDER BY hour DESC
      LIMIT 24
    `, since ? [functionId, since.toISOString()] : [functionId])

    // Get error breakdown
    const errorBreakdown = await safeDb.safeSelect(`
      SELECT 
        error_message,
        COUNT(*) as count
      FROM edge_function_invocations
      WHERE function_id = $1 AND status = 'error'
        ${since ? 'AND invoked_at >= $2' : ''}
      GROUP BY error_message
      ORDER BY count DESC
      LIMIT 10
    `, since ? [functionId, since.toISOString()] : [functionId])

    // Calculate percentiles
    const percentiles = await safeDb.safeSelect(`
      SELECT 
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY execution_time_ms) as p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_time_ms) as p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY execution_time_ms) as p99,
        MIN(execution_time_ms) as min_time,
        MAX(execution_time_ms) as max_time
      FROM edge_function_invocations
      WHERE function_id = $1 AND status = 'success'
        ${since ? 'AND invoked_at >= $2' : ''}
    `, since ? [functionId, since.toISOString()] : [functionId])

    return NextResponse.json({
      metrics: {
        ...metrics,
        percentiles: {
          p50: parseFloat(percentiles.rows[0]?.p50 || '0'),
          p95: parseFloat(percentiles.rows[0]?.p95 || '0'),
          p99: parseFloat(percentiles.rows[0]?.p99 || '0'),
          min: parseInt(percentiles.rows[0]?.min_time || '0'),
          max: parseInt(percentiles.rows[0]?.max_time || '0')
        },
        hourlyTrends: recentInvocations.rows.map(row => ({
          hour: row.hour,
          invocations: parseInt(row.invocations),
          avgExecutionTime: parseFloat(row.avg_execution_time || '0'),
          errors: parseInt(row.errors),
          timeouts: parseInt(row.timeouts),
          avgMemory: parseFloat(row.avg_memory || '0')
        })),
        errorBreakdown: errorBreakdown.rows.map(row => ({
          error: row.error_message,
          count: parseInt(row.count)
        }))
      }
    }, {
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error fetching function metrics:", error)
    return createInternalError("Failed to fetch metrics")
  }
}

