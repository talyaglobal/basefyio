import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function DELETE() {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Delete all user data
    await sql`DELETE FROM api_keys WHERE user_id = ${user.id}`
    await sql`DELETE FROM storage_files WHERE user_id = ${user.id}`
    await sql`DELETE FROM saved_queries WHERE user_id = ${user.id}`
    await sql`DELETE FROM users WHERE id = ${user.id}`

    // Clear cookie
    const response = NextResponse.json({ success: true })
    response.cookies.delete("kb_token")

    return response
  } catch (error) {
    console.error("Error deleting account:", error)
    return NextResponse.json({ error: "Failed to delete account" }, { status: 500 })
  }
}
