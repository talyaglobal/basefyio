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

    const queries = await sql`
      SELECT id, name, query, created_at
      FROM saved_queries
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC
    `

    return NextResponse.json({ queries })
  } catch (error) {
    console.error("Error fetching saved queries:", error)
    return NextResponse.json({ error: "Failed to fetch saved queries" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { name, query } = await request.json()

    if (!name || !query) {
      return NextResponse.json({ error: "Name and query are required" }, { status: 400 })
    }

    const result = await sql`
      INSERT INTO saved_queries (user_id, name, query)
      VALUES (${user.id}, ${name}, ${query})
      RETURNING id, name, query, created_at
    `

    return NextResponse.json({ success: true, query: result[0] })
  } catch (error) {
    console.error("Error saving query:", error)
    return NextResponse.json({ error: "Failed to save query" }, { status: 500 })
  }
}
