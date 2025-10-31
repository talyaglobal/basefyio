import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import bcrypt from "bcryptjs"
import { SignJWT } from "jose"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
    }

    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 })
    }

    // Check if user exists
    const existingUsers = await sql`
      SELECT id FROM users WHERE email = ${email} LIMIT 1
    `

    if (existingUsers.length > 0) {
      return NextResponse.json({ error: "User already exists" }, { status: 400 })
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10)

    // Create user
    const users = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${email}, ${passwordHash})
      RETURNING id, email, created_at
    `

    const user = users[0]

    // Create JWT token
    const accessSecret = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key")
    const refreshSecret = new TextEncoder().encode(process.env.REFRESH_SECRET || process.env.JWT_SECRET || "your-secret-key")
    const accessToken = await new SignJWT({ userId: user.id, email: user.email })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("15m")
      .sign(accessSecret)

    const rid = Math.random().toString(36).slice(2)
    const refreshToken = await new SignJWT({ userId: user.id, email: user.email, rid })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(refreshSecret)

    // Set cookie
    const response = NextResponse.json({ success: true, user: { id: user.id, email: user.email } })
    response.cookies.set("kb_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 15, // 15 minutes
    })
    response.cookies.set("kb_refresh", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    })

    // Optionally persist refresh rid
    try {
      await sql`
        INSERT INTO refresh_tokens (rid, user_id, email, issued_at, expires_at, revoked)
        VALUES (${rid}, ${user.id}, ${user.email}, NOW(), NOW() + INTERVAL '30 days', false)
      `
    } catch {}

    return response
  } catch (error) {
    console.error("Sign up error:", error)
    return NextResponse.json({ error: "An error occurred during sign up" }, { status: 500 })
  }
}
