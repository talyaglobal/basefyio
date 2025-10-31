import { NextResponse } from "next/server"
import { z } from "zod"
import { requireScopesWithRateLimit, validateRequestBody, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"

const simulateSchema = z.object({
  table: z.string().min(1),
  expression: z.string().min(1),
  where: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(1),
})

export async function POST(request: Request) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:rls"]) 
    if (!auth.success) {
      return auth.error
    }

    const validation = await validateRequestBody(request, simulateSchema)
    if (!validation.success) {
      return validation.error
    }

    const { table, expression, where, limit } = validation.data

    // Sanitize basic identifiers; expression is user-provided SQL and should be handled carefully
    const sanitizedTable = table.replace(/[^a-zA-Z0-9_]/g, "")

    // Build a safe SELECT that evaluates whether any row matches the expression (+ optional extra where)
    const base = `SELECT 1 FROM "${sanitizedTable}" WHERE (${expression})` // expression intentionally not quoted
    const query = where ? `${base} AND (${where}) LIMIT ${limit}` : `${base} LIMIT ${limit}`

    // Execute as read-only with admin override to avoid user RLS blocking the simulation
    const result = await safeDb.query(query, [], {
      allowDDL: false,
      allowDML: false,
      adminOverride: true,
      maxRows: limit,
      timeout: 15000,
    })

    // Also provide an EXPLAIN plan for insight
    const explain = await safeDb.explainQuery(base + (where ? ` AND (${where})` : ""))

    return NextResponse.json(
      {
        allowed: result.rowCount > 0,
        matchedRows: result.rowCount,
        plan: explain.rows?.[0],
      },
      { headers: { ...securityHeaders(), ...auth.rateLimitHeaders } }
    )
  } catch (error) {
    console.error("RLS simulation failed:", error)
    return createInternalError("Failed to simulate RLS policy")
  }
}


