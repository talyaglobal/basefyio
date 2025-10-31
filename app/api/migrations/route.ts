import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  validateSearchParams,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { createMigrationSchema, paginationSchema } from "@/lib/validation-schemas"
import { safeDb } from "@/lib/db-safety"
import { PaginationBuilder } from "@/lib/pagination-utils"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:migrations"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const validation = validateSearchParams(searchParams, paginationSchema)
    if (!validation.success) {
      return validation.error
    }

    const { limit, cursor } = validation.data

    const builder = new PaginationBuilder(
      safeDb,
      "migrations",
      `SELECT id, name, version, status, created_at, executed_at, rollback_at 
       FROM migrations`
    )

    const result = await builder.paginate({
      limit: limit || 20,
      cursor,
      sortBy: "version",
      sortOrder: "desc"
    })

    return NextResponse.json({
      migrations: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching migrations:", error)
    return createInternalError("Failed to fetch migrations")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:migrations"])
    if (!auth.success) {
      return auth.error
    }

    const validation = await validateRequestBody(request, createMigrationSchema)
    if (!validation.success) {
      return validation.error
    }

    const { name, up, down } = validation.data

    // Use transaction to ensure consistency
    const result = await safeDb.transaction(async (db) => {
      // Get next version number safely
      const versionResult = await db.safeSelect(`
        SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM migrations
      `)
      const version = versionResult.rows[0].next_version

      // Create migration record
      const migrationResult = await db.safeInsert(`
        INSERT INTO migrations (version, name, up_sql, down_sql, status, created_at, created_by)
        VALUES ($1, $2, $3, $4, 'pending', NOW(), $5)
        RETURNING id, version, name, status, created_at
      `, [version, name, up, down, auth.user.id])

      return migrationResult.rows[0]
    }, {
      allowDDL: false, // Migration creation doesn't need DDL
      allowDML: true
    })

    return NextResponse.json({ 
      success: true,
      migration: result
    }, {
      status: 201,
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error creating migration:", error)
    return createInternalError("Failed to create migration")
  }
}
