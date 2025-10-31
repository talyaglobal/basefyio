import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { jwtVerify, SignJWT } from "jose"
import { createHash, randomUUID } from "crypto"
import { securityHeaders, createErrorResponse, createInternalError } from "@/lib/api-utils"
import { rateLimitAuth, getClientIp } from "@/lib/rate-limit"

const sql = neon(process.env.DATABASE_URL!)

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      replaced_by TEXT
    )
  `
}

export async function POST(request: NextRequest) {
  try {
    // Rate limit by IP
    const rl = await rateLimitAuth(request)
    if (!rl.allowed) {
      return NextResponse.json({ code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" }, { status: 429, headers: securityHeaders() })
    }
    await ensureTable()

    const cookies = request.cookies
    const refreshCookie = cookies.get("kb_refresh")?.value
    if (!refreshCookie) {
      return createErrorResponse({ code: "MISSING_REFRESH", message: "No refresh token" }, 401)
    }

    const refreshSecret = new TextEncoder().encode(process.env.REFRESH_SECRET || process.env.JWT_SECRET || "your-secret-key")

    let payload: any
    try {
      const verified = await jwtVerify(refreshCookie, refreshSecret)
      payload = verified.payload
    } catch {
      return createErrorResponse({ code: "INVALID_REFRESH", message: "Invalid refresh token" }, 401)
    }

    const { userId, email, rid } = payload as { userId: string; email: string; rid: string }
    if (!userId || !rid) {
      return createErrorResponse({ code: "INVALID_REFRESH", message: "Malformed refresh token" }, 401)
    }

    const tokenHash = sha256(refreshCookie)

    // Lookup stored token
    const rows = await sql`
      SELECT id, rid, user_id, token_hash, expires_at, revoked_at, replaced_by
      FROM refresh_tokens
      WHERE user_id = ${userId} AND rid = ${rid}
      ORDER BY issued_at DESC
      LIMIT 1
    `

    if (rows.length === 0) {
      // Possible reuse: token unknown
      return createErrorResponse({ code: "REFRESH_REUSE_DETECTED", message: "Refresh token reuse detected" }, 401)
    }

    const record = rows[0]

    // Detect reuse or revocation
    if (record.revoked_at || record.replaced_by || new Date(record.expires_at) < new Date()) {
      return createErrorResponse({ code: "REFRESH_REVOKED", message: "Refresh token revoked or expired" }, 401)
    }

    // Verify hash match
    if (record.token_hash !== tokenHash) {
      // Reuse: same rid but different token presented
      await sql`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ${userId} AND rid = ${rid} AND revoked_at IS NULL`
      return createErrorResponse({ code: "REFRESH_REUSE_DETECTED", message: "Refresh token reuse detected" }, 401)
    }

    // Rotate: create new rid and tokens
    const newRid = randomUUID()
    const accessSecret = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key")
    const refreshToken = await new SignJWT({ userId, email, rid: newRid })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(refreshSecret)

    const accessToken = await new SignJWT({ userId, email })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("15m")
      .sign(accessSecret)

    const newHash = sha256(refreshToken)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    await sql`
      INSERT INTO refresh_tokens (rid, user_id, token_hash, expires_at)
      VALUES (${newRid}, ${userId}, ${newHash}, ${expiresAt.toISOString()})
    `

    await sql`
      UPDATE refresh_tokens 
      SET revoked_at = NOW(), replaced_by = ${newRid}
      WHERE user_id = ${userId} AND rid = ${rid} AND revoked_at IS NULL
    `

    const response = NextResponse.json({ success: true }, { headers: securityHeaders() })
    response.cookies.set("kb_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 15,
      path: "/",
    })
    response.cookies.set("kb_refresh", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    })

    return response
  } catch (error) {
    console.error("Refresh error:", error)
    return createInternalError("Failed to refresh session")
  }
}



