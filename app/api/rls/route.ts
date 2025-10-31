import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  validateSearchParams,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { createRlsSchema, paginationSchema } from "@/lib/validation-schemas"
import { safeDb } from "@/lib/db-safety"
import { PaginationBuilder } from "@/lib/pagination-utils"
import { z } from "zod"

const rlsQuerySchema = paginationSchema.extend({
  table: z.string().optional(),
  schema: z.string().optional().default("public"),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:rls"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const validation = validateSearchParams(searchParams, rlsQuerySchema)
    if (!validation.success) {
      return validation.error
    }

    const { limit, cursor, table, schema } = validation.data

    const builder = new PaginationBuilder(
      safeDb,
      "pg_policies",
      `SELECT 
        schemaname,
        tablename,
        policyname,
        permissive,
        roles,
        cmd,
        qual,
        with_check
      FROM pg_policies`
    )

    // Add filters
    builder.where("schemaname = $1", schema)
    
    if (table) {
      builder.where("tablename = $2", table)
    }

    const result = await builder.paginate({
      limit: limit || 20,
      cursor,
      sortBy: "tablename",
      sortOrder: "asc"
    }, "policyname")

    return NextResponse.json({
      policies: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching RLS policies:", error)
    return createInternalError("Failed to fetch RLS policies")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:rls"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can create RLS policies
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "RLS policy creation requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const validation = await validateRequestBody(request, createRlsSchema)
    if (!validation.success) {
      return validation.error
    }

    const { table, name, type, roles = [], expression } = validation.data

    // Sanitize input to prevent SQL injection
    const sanitizedTable = table.replace(/[^a-zA-Z0-9_]/g, '')
    const sanitizedName = name.replace(/[^a-zA-Z0-9_]/g, '')
    const rolesStr = roles.length > 0 ? roles.join(", ") : "public"

    // Build CREATE POLICY statement
    let policyQuery = `CREATE POLICY "${sanitizedName}" ON "${sanitizedTable}"`

    if (type !== "ALL") {
      policyQuery += ` FOR ${type}`
    }

    policyQuery += ` TO ${rolesStr}`
    policyQuery += ` USING (${expression})`

    // Execute with admin permissions
    await safeDb.adminQuery(policyQuery, [], {
      timeout: 30000,
      allowDDL: true,
      allowDML: false
    })

    // Log policy creation
    await safeDb.safeInsert(`
      INSERT INTO rls_policy_log (table_name, policy_name, action, created_by, created_at)
      VALUES ($1, $2, 'CREATE', $3, NOW())
    `, [table, name, auth.user.id])

    return NextResponse.json({ 
      success: true, 
      message: "RLS policy created successfully",
      policy: {
        table: sanitizedTable,
        name: sanitizedName,
        type,
        roles,
        expression
      }
    }, {
      status: 201,
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error creating RLS policy:", error)
    
    // Check if it's a policy-specific error
    if (error.message.includes('already exists')) {
      return NextResponse.json({
        code: "POLICY_EXISTS",
        message: "A policy with this name already exists for this table"
      }, { 
        status: 409,
        headers: securityHeaders()
      })
    }

    return createInternalError("Failed to create RLS policy")
  }
}
