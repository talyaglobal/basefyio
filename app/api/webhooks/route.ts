import { type NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export async function GET() {
  try {
    const webhooks = await sql`
      SELECT * FROM webhooks 
      ORDER BY created_at DESC
    `

    return NextResponse.json({ webhooks })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, url, events, enabled = true, secret } = body

    const result = await sql`
      INSERT INTO webhooks (name, url, events, enabled, secret)
      VALUES (${name}, ${url}, ${events}, ${enabled}, ${secret})
      RETURNING *
    `

    return NextResponse.json({ webhook: result[0] })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
