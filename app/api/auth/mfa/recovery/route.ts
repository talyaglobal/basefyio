import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { randomBytes, createHash } from "crypto"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

function generateCodes(count = 10) {
  return Array.from({ length: count }, () => randomBytes(4).toString("hex"))
}

export async function POST() {
  try {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await sql`CREATE TABLE IF NOT EXISTS user_recovery_codes (user_id text, code_hash text, used_at timestamptz)`

    const codes = generateCodes()
    const hashes = codes.map((c) => createHash("sha256").update(c).digest("hex"))
    await sql`DELETE FROM user_recovery_codes WHERE user_id = ${user.id}`
    for (const h of hashes) {
      // eslint-disable-next-line no-await-in-loop
      await sql`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (${user.id}, ${h})`
    }
    return NextResponse.json({ codes })
  } catch (e) {
    return NextResponse.json({ error: "Failed to generate recovery codes" }, { status: 500 })
  }
}


