import { type NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export async function GET() {
  try {
    const migrations = await sql`
      SELECT * FROM migrations 
      ORDER BY version DESC
    `

    return NextResponse.json({ migrations })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, up_sql, down_sql } = body

    // Get next version number
    const result = await sql`
      SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM migrations
    `
    const version = result[0].next_version

    const migration = await sql`
      INSERT INTO migrations (version, name, up_sql, down_sql, status)
      VALUES (${version}, ${name}, ${up_sql}, ${down_sql}, 'pending')
      RETURNING *
    `

    return NextResponse.json({ migration: migration[0] })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
