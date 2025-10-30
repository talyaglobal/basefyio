import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { query } = await request.json()

    if (!query || !query.trim()) {
      return NextResponse.json({ error: "Query is required" }, { status: 400 })
    }

    // Execute the query
    const result = await sql(query)

    // Extract column names if results exist
    let columns: string[] = []
    if (result.length > 0) {
      columns = Object.keys(result[0])
    }

    return NextResponse.json({
      rows: result,
      columns,
      success: true,
    })
  } catch (error: any) {
    console.error("SQL execution error:", error)
    return NextResponse.json(
      {
        error: error.message || "Failed to execute query",
      },
      { status: 400 },
    )
  }
}
