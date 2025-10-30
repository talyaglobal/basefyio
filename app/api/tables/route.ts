import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function GET() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get all tables from public schema
    const tables = await sql`
      SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.tables t2 
         WHERE t2.table_name = t.table_name AND t2.table_schema = 'public') as row_count
      FROM information_schema.tables t
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `

    // Get row counts for each table
    const tablesWithCounts = await Promise.all(
      tables.map(async (table) => {
        try {
          const result = await sql(`SELECT COUNT(*) as count FROM ${sql(table.table_name)}`)
          return {
            table_name: table.table_name,
            row_count: Number(result[0].count),
          }
        } catch {
          return {
            table_name: table.table_name,
            row_count: 0,
          }
        }
      }),
    )

    return NextResponse.json({ tables: tablesWithCounts })
  } catch (error) {
    console.error("Error fetching tables:", error)
    return NextResponse.json({ error: "Failed to fetch tables" }, { status: 500 })
  }
}
