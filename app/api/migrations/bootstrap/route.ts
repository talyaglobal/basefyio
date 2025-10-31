import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { securityHeaders } from "@/lib/api-utils"

export async function POST() {
  try {
    const sql = neon(process.env.DATABASE_URL!)
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
    await sql`
      CREATE TABLE IF NOT EXISTS user_mfa (
        user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        secret TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
    return NextResponse.json({ success: true }, { headers: securityHeaders() })
  } catch (e) {
    return NextResponse.json({ code: "BOOTSTRAP_FAILED", message: "Failed to bootstrap auth tables" }, { status: 500 })
  }
}


