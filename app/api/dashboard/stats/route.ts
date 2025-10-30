import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export async function GET() {
  try {
    // Get table count
    const tableResult = await sql`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `
    const tableCount = Number(tableResult[0].count)

    // Get total rows across all tables
    const rowsResult = await sql`
      SELECT SUM(n_live_tup) as total
      FROM pg_stat_user_tables
    `
    const totalRows = Number(rowsResult[0].total) || 0

    // Get storage size
    const storageResult = await sql`
      SELECT pg_database_size(current_database()) as size
    `
    const storageSize = Number(storageResult[0].size)

    // Get API keys count
    const apiKeysResult = await sql`
      SELECT COUNT(*) as count FROM api_keys
    `
    const apiKeysCount = Number(apiKeysResult[0].count)

    return NextResponse.json({
      tables: tableCount,
      rows: totalRows,
      storage: storageSize,
      apiKeys: apiKeysCount,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
