import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function PUT(request: Request) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { email } = await request.json()

    if (!email || !email.trim()) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 })
    }

    // Check if email is already taken
    const existing = await sql`
      SELECT id FROM users WHERE email = ${email} AND id != ${user.id} LIMIT 1
    `

    if (existing.length > 0) {
      return NextResponse.json({ error: "Email already in use" }, { status: 400 })
    }

    await sql`
      UPDATE users
      SET email = ${email}
      WHERE id = ${user.id}
    `

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error updating email:", error)
    return NextResponse.json({ error: "Failed to update email" }, { status: 500 })
  }
}
