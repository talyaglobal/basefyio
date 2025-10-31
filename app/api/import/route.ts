import { type NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { table, data, mode = "insert" } = body

    if (!Array.isArray(data) || data.length === 0) {
      return NextResponse.json({ error: "Invalid data format" }, { status: 400 })
    }

    let successCount = 0
    let errorCount = 0
    const errors: string[] = []

    for (const row of data) {
      try {
        const columns = Object.keys(row)
        const values = Object.values(row)
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ")

        if (mode === "upsert") {
          // Implement upsert logic (requires primary key)
          const updateSet = columns.map((col, i) => `${col} = $${i + 1}`).join(", ")
          const upsertQuery = `
            INSERT INTO ${table} (${columns.join(", ")})
            VALUES (${placeholders})
            ON CONFLICT DO UPDATE SET ${updateSet}
          `
          await sql(upsertQuery as any, values as any)
        } else {
          // Simple insert
          const insertQuery = `
            INSERT INTO ${table} (${columns.join(", ")})
            VALUES (${placeholders})
          `
          await sql(insertQuery as any, values as any)
        }

        successCount++
      } catch (error: any) {
        errorCount++
        errors.push(error.message)
      }
    }

    return NextResponse.json({
      success: true,
      imported: successCount,
      failed: errorCount,
      errors: errors.slice(0, 10), // Return first 10 errors
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
