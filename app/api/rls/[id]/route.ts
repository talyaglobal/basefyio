import { type NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const [table, policyName] = params.id.split(":")

    await sql(`DROP POLICY IF EXISTS "${policyName}" ON "${table}"`)

    return NextResponse.json({ success: true, message: "Policy deleted successfully" })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const [table, oldPolicyName] = params.id.split(":")
    const body = await request.json()
    const { name, command, using, check, roles } = body

    // Drop old policy
    await sql(`DROP POLICY IF EXISTS "${oldPolicyName}" ON "${table}"`)

    // Create new policy
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

    return NextResponse.json({ success: true, message: "Policy updated successfully" })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
