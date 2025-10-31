import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireScopesWithRateLimit, validateSearchParams, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"

const auditQuerySchema = z.object({
  table: z.string().optional(),
  policy: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:rls"]) 
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const validation = validateSearchParams(searchParams, auditQuerySchema)
    if (!validation.success) {
      return validation.error
    }

    const { table, policy, limit } = validation.data

    let query = `SELECT id, table_name, policy_name, action, created_by, created_at
                 FROM rls_policy_log`
    const where: string[] = []
    const params: any[] = []

    if (table) {
      where.push(`table_name = $${params.length + 1}`)
      params.push(table)
    }
    if (policy) {
      where.push(`policy_name = $${params.length + 1}`)
      params.push(policy)
    }

    if (where.length > 0) {
      query += ` WHERE ${where.join(' AND ')}`
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit}`

    const result = await safeDb.safeSelect(query, params, { maxRows: limit })

    return NextResponse.json(
      { events: result.rows },
      { headers: { ...securityHeaders(), ...auth.rateLimitHeaders } }
    )
  } catch (error) {
    console.error("Failed to fetch RLS audit log:", error)
    return createInternalError("Failed to fetch RLS audit log")
  }
}


