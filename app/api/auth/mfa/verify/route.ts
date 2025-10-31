import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { authenticator } from "otplib"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: NextRequest) {
  try {
    const { token, userId } = await request.json()
    
    // If userId is provided, use it directly (for API key auth)
    let targetUserId = userId
    
    // If no userId provided, get from session
    if (!targetUserId) {
      const user = await getUser()
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      targetUserId = user.id
    }

    if (!token) {
      return NextResponse.json({ code: "INVALID_INPUT", message: "token required" }, { status: 400 })
    }

    const rows = await sql`SELECT secret FROM user_mfa WHERE user_id = ${targetUserId} LIMIT 1`
    if (rows.length === 0) {
      return NextResponse.json({ code: "MFA_NOT_SETUP", message: "MFA not set up" }, { status: 400 })
    }

    const isValid = authenticator.verify({ token, secret: rows[0].secret })
    if (!isValid) {
      return NextResponse.json({ code: "MFA_INVALID", message: "Invalid MFA token" }, { status: 401 })
    }

    // Enable MFA if not already enabled
    await sql`UPDATE user_mfa SET enabled = true WHERE user_id = ${targetUserId}`
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ code: "MFA_VERIFY_FAILED", message: "Failed to verify MFA token" }, { status: 500 })
  }
}


