import { NextResponse } from "next/server"
import { jwtVerify, SignJWT } from "jose"
import { neon } from "@neondatabase/serverless"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get("token")
    if (!token) return NextResponse.json({ code: "INVALID_TOKEN", message: "Missing token" }, { status: 400 })

    const magicSecret = new TextEncoder().encode(process.env.MAGIC_SECRET || process.env.JWT_SECRET || "your-secret-key")
    const accessSecret = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key")
    const refreshSecret = new TextEncoder().encode(process.env.REFRESH_SECRET || process.env.JWT_SECRET || "your-secret-key")

    const { payload } = await jwtVerify(token, magicSecret)
    const email = payload.email as string
    if (!email) return NextResponse.json({ code: "INVALID_TOKEN", message: "Invalid token payload" }, { status: 400 })

    // Issue auth cookies
    const userId = `magic-${Buffer.from(email).toString("hex").slice(0, 8)}`
    const accessToken = await new SignJWT({ userId, email })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("15m")
      .sign(accessSecret)

    const rid = Math.random().toString(36).slice(2)
    const refreshToken = await new SignJWT({ userId, email, rid })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(refreshSecret)

    const res = NextResponse.json({ success: true, user: { id: userId, email } })
    res.cookies.set("kb_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 15,
      path: "/",
    })
    res.cookies.set("kb_refresh", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    })
    // Optional: persist refresh rid
    try {
      const sql = neon(process.env.DATABASE_URL!)
      await sql`
        INSERT INTO refresh_tokens (rid, user_id, email, issued_at, expires_at, revoked)
        VALUES (${rid}, ${userId}, ${email}, NOW(), NOW() + INTERVAL '30 days', false)
      `
    } catch {}
    return res
  } catch (e) {
    return NextResponse.json({ code: "INVALID_TOKEN", message: "Invalid or expired magic link" }, { status: 400 })
  }
}


