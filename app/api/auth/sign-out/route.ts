import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { cookies } from "next/headers"
import { jwtVerify } from "jose"

export async function POST() {
  const response = NextResponse.json({ success: true })
  response.cookies.delete("kb_token")
  response.cookies.delete("kb_refresh")
  // Optionally revoke all user's refresh tokens
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get("kb_token")
    if (token) {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key")
      const { payload } = await jwtVerify(token.value, secret)
      const userId = payload.userId as string
      const sql = neon(process.env.DATABASE_URL!)
      await sql`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ${userId} AND revoked_at IS NULL`
    }
  } catch {}
  return response
}
