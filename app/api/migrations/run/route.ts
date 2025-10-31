import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  createNotFoundError,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { runMigrationSchema } from "@/lib/validation-schemas"
import { safeDb } from "@/lib/db-safety"

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:migrations"])
    if (!auth.success) {
      return auth.error
    }

    const validation = await validateRequestBody(request, runMigrationSchema)
    if (!validation.success) {
      return validation.error
    }

    const { direction = "up", steps = 1, dryRun = false } = validation.data

    // Only session users (not API keys) can run non-dry-run migrations
    if (!dryRun && auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Migration execution requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Get pending/executed migrations based on direction
    let query: string
    if (direction === "up") {
      query = `SELECT id, name, version, up_sql, down_sql, status 
               FROM migrations 
               WHERE status = 'pending' 
               ORDER BY version ASC 
               LIMIT ${steps}`
    } else {
      query = `SELECT id, name, version, up_sql, down_sql, status 
               FROM migrations 
               WHERE status = 'executed' 
               ORDER BY version DESC 
               LIMIT ${steps}`
    }

    const migrationsResult = await safeDb.safeSelect(query)
    const migrationsToRun = migrationsResult.rows

    if (migrationsToRun.length === 0) {
      return NextResponse.json({
        success: true,
        message: `No ${direction === "up" ? "pending" : "executed"} migrations found`,
        results: []
      }, {
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const results: any[] = []

    if (dryRun) {
      // For dry run, just validate and return what would be executed
      for (const migration of migrationsToRun) {
        const sqlToExecute = direction === "up" ? migration.up_sql : migration.down_sql
        
        try {
          // Validate SQL syntax by explaining it
          await safeDb.adminQuery(`EXPLAIN ${sqlToExecute}`, [], { timeout: 10000 })
          
          results.push({
            id: migration.id,
            name: migration.name,
            version: migration.version,
            direction,
            status: "would_execute",
            sql: sqlToExecute
          })
        } catch (error: any) {
          results.push({
            id: migration.id,
            name: migration.name,
            version: migration.version,
            direction,
            status: "invalid_sql",
            error: error.message,
            sql: sqlToExecute
          })
        }
      }
    } else {
      // Execute migrations with full admin permissions in transaction
      try {
        await safeDb.transaction(async (db) => {
          for (const migration of migrationsToRun) {
            const sqlToExecute = direction === "up" ? migration.up_sql : migration.down_sql

            try {
              // Execute the migration SQL with admin override
              await db.adminQuery(sqlToExecute, [], {
                timeout: 60000, // 1 minute timeout for migrations
                allowDDL: true,
                allowDML: true
              })

              // Update migration status
              const newStatus = direction === "up" ? "executed" : "rolled_back"
              const timestampField = direction === "up" ? "executed_at" : "rollback_at"

              await db.safeUpdate(`
                UPDATE migrations 
                SET status = $1, ${timestampField} = NOW(), executed_by = $2
                WHERE id = $3
              `, [newStatus, auth.user.id, migration.id])

              results.push({
                id: migration.id,
                name: migration.name,
                version: migration.version,
                status: newStatus,
                direction,
              })
            } catch (error: any) {
              results.push({
                id: migration.id,
                name: migration.name,
                version: migration.version,
                status: "failed",
                direction,
                error: error.message,
              })
              throw error // This will cause transaction rollback
            }
          }
        }, {
          adminOverride: true // Use admin override for the transaction
        })
      } catch (error: any) {
        console.error("Migration execution failed:", error)
        return NextResponse.json({
          code: "MIGRATION_FAILED", 
          message: "Migration execution failed and was rolled back",
          results
        }, { 
          status: 500,
          headers: {
            ...securityHeaders(),
            ...auth.rateLimitHeaders,
          }
        })
      }
    }

    return NextResponse.json({ 
      success: true,
      dryRun,
      direction,
      results
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error running migrations:", error)
    return createInternalError("Failed to run migrations")
  }
}
