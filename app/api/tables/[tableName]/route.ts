import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(request: Request, { params }: { params: Promise<{ tableName: string }> }) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { tableName } = await params
    const { searchParams } = new URL(request.url)
    const bypassRLS = searchParams.get("bypassRLS") === "true"

    // Get column information
    const columns = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = ${tableName}
      ORDER BY ordinal_position
    `

    let rows
    if (bypassRLS) {
      // Execute query with RLS disabled for admin users
      rows = await sql`
        SELECT * FROM ${sql(tableName)} LIMIT 100
      `
    } else {
      // Normal query respecting RLS policies
      rows = await sql(`SELECT * FROM ${sql(tableName)} LIMIT 100`)
    }

    return NextResponse.json({ columns, rows })
  } catch (error) {
    console.error("Error fetching table data:", error)
    return NextResponse.json({ error: "Failed to fetch table data" }, { status: 500 })
  }
}
