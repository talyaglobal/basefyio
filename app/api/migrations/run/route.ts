import { type NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, direction = "up" } = body

    // Get migration
    const migrations = await sql`
      SELECT * FROM migrations WHERE id = ${id}
    `

    if (migrations.length === 0) {
      return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    }

    const migration = migrations[0]
    const sqlToRun = direction === "up" ? migration.up_sql : migration.down_sql

    // Run migration
    await sql(sqlToRun)

    // Update status
    const newStatus = direction === "up" ? "applied" : "rolled_back"
    await sql`
      UPDATE migrations 
      SET status = ${newStatus}, 
          applied_at = ${direction === "up" ? new Date().toISOString() : null}
      WHERE id = ${id}
    `

    return NextResponse.json({
      success: true,
      message: `Migration ${direction === "up" ? "applied" : "rolled back"} successfully`,
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
