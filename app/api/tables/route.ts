import { NextResponse } from "next/server"
import { requireScopes, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"

export async function GET() {
  try {
    const auth = await requireScopes(["read:tables"])
    if (!auth.success) {
      return auth.error
    }

    // Get all tables from public schema
    const tablesResult = await safeDb.safeSelect(`
      SELECT table_name
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `)

    // Get row counts for each table safely
    const tablesWithCounts = await Promise.all(
      tablesResult.rows.map(async (table: any) => {
        try {
          const countResult = await safeDb.safeSelect(
            `SELECT COUNT(*) as count FROM ${table.table_name}`,
            [],
            { timeout: 10000 } // 10 second timeout for count queries
          )
          return {
            table_name: table.table_name,
            row_count: Number(countResult.rows[0].count),
          }
        } catch {
          return {
            table_name: table.table_name,
            row_count: 0,
          }
        }
      }),
    )

    return NextResponse.json({ tables: tablesWithCounts }, {
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error fetching tables:", error)
    return createInternalError("Failed to fetch tables")
  }
}
