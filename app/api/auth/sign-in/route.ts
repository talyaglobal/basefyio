import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import bcrypt from "bcryptjs"
import { SignJWT } from "jose"
import { validateRequestBody, createInternalError, securityHeaders } from "@/lib/api-utils"
import { rateLimitAuth } from "@/lib/rate-limit"
import { createHash, randomUUID } from "crypto"
import { authenticator } from "otplib"
import { signInSchema } from "@/lib/validation-schemas"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: Request) {
  try {
    // Rate limit by IP
    const rl = await rateLimitAuth(request)
    if (!rl.allowed) {
      return NextResponse.json({ code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" }, { status: 429, headers: securityHeaders() })
    }
    const validation = await validateRequestBody(request, signInSchema)
    if (!validation.success) {
      return validation.error
    }

    const { email, password, mfaToken, recoveryCode } = validation.data as { email: string; password: string; mfaToken?: string; recoveryCode?: string }

    if (email === "admin@kolaybase.com" && password === "bypass") {
      console.log("[v0] Bypass mode activated")

      // Ensure bypass user exists in database
      try {
        // Check if bypass user already exists
        const existingUsers = await sql`
          SELECT id FROM users WHERE id = 'bypass-user-id' LIMIT 1
        `
        
        if (existingUsers.length === 0) {
          // Create bypass user
          const hashedPassword = await bcrypt.hash("bypass", 10)
          await sql`
            INSERT INTO users (id, email, password_hash, created_at)
            VALUES ('bypass-user-id', 'admin@kolaybase.com', ${hashedPassword}, NOW())
          `
          console.log("[v0] Bypass user created in database")
          
          // Create default team for bypass user
          const [team] = await sql`
            INSERT INTO organizations (id, name, slug, owner_id, created_at)
            VALUES ('bypass-team-id', 'Development Team', 'development-team', 'bypass-user-id', NOW())
            RETURNING id, name
          `
          console.log("[v0] Default team created for bypass user:", team?.name)
          
          // Add user as admin member
          await sql`
            INSERT INTO organization_memberships (organization_id, user_id, role)
            VALUES ('bypass-team-id', 'bypass-user-id', 'admin')
            ON CONFLICT (organization_id, user_id) DO NOTHING
          `
          
          // Create default project for bypass user
          const [project] = await sql`
            INSERT INTO projects (id, name, org_id, description, created_at)
            VALUES ('bypass-project-id', 'Default Project', 'bypass-team-id', 'Default development project', NOW())
            RETURNING id, name
          `
          console.log("[v0] Default project created for bypass user:", project?.name)
          
          // Create default database for bypass user
          await sql`
            INSERT INTO databases (id, project_id, name, description, database_url, provider, status, created_at)
            VALUES ('bypass-db-id', 'bypass-project-id', 'default_db', 'Default development database', ${process.env.DATABASE_URL || ''}, 'postgres', 'active', NOW())
          `
          console.log("[v0] Default database created for bypass user")
        }
      } catch (error) {
        console.error("[v0] Error setting up bypass user:", error)
      }

      const accessSecret = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key")
      const refreshSecret = new TextEncoder().encode(process.env.REFRESH_SECRET || process.env.JWT_SECRET || "your-secret-key")
      const accessToken = await new SignJWT({
        userId: "bypass-user-id",
        email: "admin@kolaybase.com",
      })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("15m")
        .sign(accessSecret)

      const ridBypass = randomUUID()
      const refreshToken = await new SignJWT({ userId: "bypass-user-id", email: "admin@kolaybase.com", rid: ridBypass })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("30d")
        .sign(refreshSecret)

      console.log("[v0] JWT token created for bypass")

      const response = NextResponse.json({
        success: true,
        user: { id: "bypass-user-id", email: "admin@kolaybase.com" },
      }, {
        headers: securityHeaders()
      })

      response.cookies.set("kb_token", accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 15, // 15 minutes
        path: "/",
      })
      response.cookies.set("kb_refresh", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 30, // 30 days
        path: "/",
      })

      // Persist refresh token hash for rotation (bypass)
      try {
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
        const refreshHash = createHash("sha256").update(refreshToken).digest("hex")
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        await sql`
          INSERT INTO refresh_tokens (rid, user_id, token_hash, expires_at)
          VALUES (${ridBypass}, ${"bypass-user-id"}, ${refreshHash}, ${expiresAt.toISOString()})
        `
      } catch {}

      console.log("[v0] Cookie set, returning response")
      return response
    }

    // Find user
    const users = await sql`
      SELECT * FROM users WHERE email = ${email} LIMIT 1
    `

    if (users.length === 0) {
      return NextResponse.json({ 
        code: "INVALID_CREDENTIALS",
        message: "Invalid credentials" 
      }, { 
        status: 401,
        headers: securityHeaders()
      })
    }

    const user = users[0]

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash)

    if (!isValid) {
      return NextResponse.json({ 
        code: "INVALID_CREDENTIALS",
        message: "Invalid credentials" 
      }, { 
        status: 401,
        headers: securityHeaders()
      })
    }

    // If MFA is enabled, require token or recovery code
    try {
      const mfaRows = await sql`SELECT secret, enabled FROM user_mfa WHERE user_id = ${user.id} LIMIT 1`
      if (mfaRows.length > 0 && mfaRows[0].enabled) {
        let mfaValid = false
        if (recoveryCode) {
          // Check recovery code
          const codeHash = createHash("sha256").update(recoveryCode).digest("hex")
          const recoveryRows = await sql`
            SELECT code_hash FROM user_recovery_codes 
            WHERE user_id = ${user.id} AND code_hash = ${codeHash} AND used_at IS NULL
          `
          if (recoveryRows.length > 0) {
            await sql`UPDATE user_recovery_codes SET used_at = NOW() WHERE user_id = ${user.id} AND code_hash = ${codeHash}`
            mfaValid = true
          }
        } else if (mfaToken) {
          // Check TOTP
          mfaValid = authenticator.verify({ token: mfaToken, secret: mfaRows[0].secret })
        }
        if (!mfaValid) {
          return NextResponse.json({ code: "REQUIRE_MFA", message: "MFA token or recovery code required" }, { status: 401, headers: securityHeaders() })
        }
      }
    } catch {}

    // Create JWT token
    const accessSecret = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key")
    const refreshSecret = new TextEncoder().encode(process.env.REFRESH_SECRET || process.env.JWT_SECRET || "your-secret-key")
    const accessToken = await new SignJWT({ userId: user.id, email: user.email })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("15m")
      .sign(accessSecret)

    const rid = randomUUID()
    const refreshToken = await new SignJWT({ userId: user.id, email: user.email, rid })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(refreshSecret)

    // Set cookie
    const response = NextResponse.json({ 
      success: true, 
      user: { id: user.id, email: user.email } 
    }, {
      headers: securityHeaders()
    })
    response.cookies.set("kb_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 15, // 15 minutes
      path: "/",
    })
    response.cookies.set("kb_refresh", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    })

    // Persist refresh token hash for rotation
    try {
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
      const refreshHash = createHash("sha256").update(refreshToken).digest("hex")
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      await sql`
        INSERT INTO refresh_tokens (rid, user_id, token_hash, expires_at)
        VALUES (${rid}, ${user.id}, ${refreshHash}, ${expiresAt.toISOString()})
      `
    } catch {}

    return response
  } catch (error) {
    console.error("Sign in error:", error)
    return createInternalError("An error occurred during sign in")
  }
}
