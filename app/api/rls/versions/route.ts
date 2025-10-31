








import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireScopesWithRateLimit, validateSearchParams, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"
import { PaginationBuilder } from "@/lib/pagination-utils"

const versionsQuerySchema = z.object({
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
    const validation = validateSearchParams(searchParams, versionsQuerySchema)
    if (!validation.success) {
      return validation.error
    }

    const { table, policy, limit, cursor } = validation.data

    // Query RLS policy versions from version history table
    const builder = new PaginationBuilder(
      safeDb,
      "rls_policy_versions",
      `SELECT 
        id,
        policy_name,
        table_name,
        schema_name,
        version,
        definition,
        created_at,
        created_by
      FROM rls_policy_versions`
    )

    if (table) {
      builder.where("table_name = $1", table)
    }
    if (policy) {
      builder.where("policy_name = $2", policy)
    }

    const result = await builder.paginate({
      limit: limit || 20,
      cursor,
      sortBy: "created_at",
      sortOrder: "desc"
    }, "id")

    return NextResponse.json({
      versions: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error) {
    console.error("Failed to fetch RLS policy versions:", error)
    return createInternalError("Failed to fetch RLS policy versions")
  }
}

