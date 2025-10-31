import { NextRequest, NextResponse } from "next/server"
import { requireAuth, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"
import { edgeFunctionRuntime } from "@/lib/edge-functions"

// Force Node.js runtime
export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const body = await request.json().catch(() => ({}))
    const version = body.version ? parseInt(body.version) : null

    // Get function details
    let query = `
      SELECT id, name, slug, description, runtime, source_code, environment_variables,
             timeout_ms, memory_limit_mb, is_active, version, created_by
      FROM edge_functions 
      WHERE slug = $1 AND created_by = $2
    `
    const queryParams: any[] = [slug, auth.user.id]

    if (version) {
      query += ` AND version = $3`
      queryParams.push(version)
    } else {
      query += ` AND is_active = TRUE`
    }

    query += ` ORDER BY version DESC LIMIT 1`

    const result = await safeDb.safeSelect(query, queryParams)

    if (result.rows.length === 0) {
      return NextResponse.json({
        code: "FUNCTION_NOT_FOUND",
        message: "Function not found or you don't have permission to invoke it"
      }, {
        status: 404,
        headers: securityHeaders()
      })
    }

    const func = result.rows[0]

    if (!func.is_active && !version) {
      return NextResponse.json({
        code: "FUNCTION_INACTIVE",
        message: "Function is not active"
      }, {
        status: 400,
        headers: securityHeaders()
      })
    }

    // Create invocation context
    const context = {
      function_id: func.id,
      user_id: auth.user.id,
      request: {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body: body.body || body
      },
      secrets: {}, // TODO: Load secrets from secrets manager
      environment: func.environment_variables || {}
    }

    // Try Docker runtime first, fallback to standard runtime
    let invocationResult

    try {
      // Try Docker execution with dynamic import
      const { dockerEdgeFunctionRuntime } = await import('@/lib/edge-functions-docker')
      invocationResult = await dockerEdgeFunctionRuntime.invokeFunction(func, context, {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 10000,
        backoffMultiplier: 2
      })
    } catch (dockerError: any) {
      // Fallback to standard runtime if Docker fails
      console.warn('Docker execution failed, falling back to standard runtime:', dockerError)
      invocationResult = await edgeFunctionRuntime.invokeFunction(func, context)
    }

    if (!invocationResult.success) {
      return NextResponse.json({
        code: "EXECUTION_FAILED",
        message: invocationResult.error,
        logs: invocationResult.logs,
        attempts: (invocationResult as any).attempts || 1
      }, {
        status: 500,
        headers: securityHeaders()
      })
    }

    return NextResponse.json({
      success: true,
      result: invocationResult.result,
      logs: invocationResult.logs,
      executionTime: invocationResult.executionTime,
      memoryUsed: invocationResult.memoryUsed,
      attempts: (invocationResult as any).attempts || 1
    }, {
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error invoking edge function:", error)
    return createInternalError("Failed to invoke function")
  }
}

