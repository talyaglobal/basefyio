import { NextRequest, NextResponse } from "next/server"
import { requireScopes, validateRequestBody, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"
import { z } from "zod"

const explainQuerySchema = z.object({
  query: z.string().min(1, "Query is required"),
  params: z.array(z.any()).optional().default([]),
  analyze: z.boolean().optional().default(true),
  buffers: z.boolean().optional().default(true),
  costs: z.boolean().optional().default(true),
})

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopes(["admin"])
    if (!auth.success) {
      return auth.error
    }

    const validation = await validateRequestBody(request, explainQuerySchema)
    if (!validation.success) {
      return validation.error
    }

    const { query, params, analyze, buffers, costs } = validation.data

    // Build EXPLAIN options
    const explainOptions = []
    if (analyze) explainOptions.push("ANALYZE true")
    if (buffers) explainOptions.push("BUFFERS true")
    if (costs) explainOptions.push("COSTS true")
    explainOptions.push("FORMAT JSON")

    const explainQuery = `EXPLAIN (${explainOptions.join(", ")}) ${query}`

    const result = await safeDb.adminQuery(explainQuery, params, {
      timeout: 60000, // 1 minute timeout for EXPLAIN
      maxRows: 1000,
    })

    return NextResponse.json({
      success: true,
      executionPlan: result.rows[0] || {},
      executionTime: result.executionTime,
      query: query,
      warnings: result.warnings,
    }, {
      headers: securityHeaders()
    })

  } catch (error) {
    console.error("Error explaining query:", error)
    return createInternalError(`Failed to explain query: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}