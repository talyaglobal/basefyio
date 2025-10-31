import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { authenticator } from "otplib"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function POST() {
  try {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await sql`CREATE TABLE IF NOT EXISTS user_mfa (user_id text primary key, secret text not null, enabled boolean not null default false)`

    const secret = authenticator.generateSecret()
    await sql`
      INSERT INTO user_mfa (user_id, secret, enabled)
      VALUES (${user.id}, ${secret}, false)
      ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, enabled = false
    `

    const otpauth = authenticator.keyuri(user.email, "Kolaybase", secret)
    return NextResponse.json({ secret, otpauth })
  } catch (e) {
    return NextResponse.json({ error: "Failed to enroll MFA" }, { status: 500 })
  }
}


