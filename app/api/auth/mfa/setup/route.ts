import { NextResponse } from "next/server"
import { authenticator } from "otplib"
import { neon } from "@neondatabase/serverless"

export async function POST(request: Request) {
  try {
    const { email, userId } = await request.json()
    if (!email) return NextResponse.json({ code: "INVALID_INPUT", message: "Email is required" }, { status: 400 })

    const issuer = process.env.NEXT_PUBLIC_APP_NAME || "Kolaybase"
    const secret = authenticator.generateSecret()
    const otpauth = authenticator.keyuri(email, issuer, secret)

    // Persist secret against the user in DB if possible
    try {
      const sql = neon(process.env.DATABASE_URL!)
      const uid = userId || `magic-${Buffer.from(email).toString("hex").slice(0, 8)}`
      await sql`
        INSERT INTO user_mfa (user_id, email, secret, enabled, updated_at)
        VALUES (${uid}, ${email}, ${secret}, true, NOW())
        ON CONFLICT (user_id) DO UPDATE SET secret = ${secret}, enabled = true, updated_at = NOW()
      `
    } catch {}

    return NextResponse.json({ secret, otpauth })
  } catch (e) {
    return NextResponse.json({ code: "MFA_SETUP_FAILED", message: "Failed to setup MFA" }, { status: 500 })
  }
}


