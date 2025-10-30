import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"
import crypto from "crypto"

const sql = neon(process.env.DATABASE_URL!)

export async function GET() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const keys = await sql`
      SELECT id, name, key, created_at, last_used
      FROM api_keys
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC
    `

    return NextResponse.json({ keys })
  } catch (error) {
    console.error("Error fetching API keys:", error)
    return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { name } = await request.json()

    if (!name || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 })
    }

    // Generate a secure API key
    const apiKey = `kb_${crypto.randomBytes(32).toString("hex")}`

    const result = await sql`
      INSERT INTO api_keys (user_id, name, key)
      VALUES (${user.id}, ${name}, ${apiKey})
      RETURNING id, name, key, created_at, last_used
    `

    return NextResponse.json({ success: true, key: result[0] })
  } catch (error) {
    console.error("Error creating API key:", error)
    return NextResponse.json({ error: "Failed to create API key" }, { status: 500 })
  }
}
