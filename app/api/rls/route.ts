import { type NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const table = searchParams.get("table")

    let query = `
      SELECT 
        schemaname,
        tablename,
        policyname,
        permissive,
        roles,
        cmd,
        qual,
        with_check
      FROM pg_policies
    `

    if (table) {
      query += ` WHERE tablename = '${table}'`
    }

    query += ` ORDER BY schemaname, tablename, policyname`

    const policies = await sql(query)

    return NextResponse.json({ policies })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { table, name, command, using, check, roles } = body

    const rolesStr = roles?.join(", ") || "public"

    let query = `CREATE POLICY "${name}" ON "${table}"`

    if (command) {
      query += ` FOR ${command}`
    }

    query += ` TO ${rolesStr}`

    if (using) {
      query += ` USING (${using})`
    }

    if (check) {
      query += ` WITH CHECK (${check})`
    }

    await sql(query)

    return NextResponse.json({ success: true, message: "Policy created successfully" })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
