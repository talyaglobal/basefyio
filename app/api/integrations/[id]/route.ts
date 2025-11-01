import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id } = await params

    const integrations = await sql`
      SELECT 
        id,
        user_id,
        team_id,
        project_id,
        provider,
        status,
        provider_user_id,
        provider_username,
        provider_email,
        provider_avatar_url,
        config,
        last_sync_at,
        sync_status,
        sync_error,
        connected_at,
        updated_at
      FROM integrations
      WHERE id = ${id} AND user_id = ${user.id}
      LIMIT 1
    `

    if (integrations.length === 0) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 })
    }

    return NextResponse.json({
      integration: {
        ...integrations[0],
        config: integrations[0].config || {},
      },
    })
  } catch (error) {
    console.error("Error fetching integration:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id } = await params

    // Verify ownership
    const integrations = await sql`
      SELECT id, provider FROM integrations
      WHERE id = ${id} AND user_id = ${user.id}
      LIMIT 1
    `

    if (integrations.length === 0) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 })
    }

    // Delete integration (cascade will handle related records)
    await sql`
      UPDATE integrations
      SET status = 'disconnected',
          disconnected_at = NOW(),
          updated_at = NOW()
      WHERE id = ${id}
    `

    // TODO: Revoke OAuth tokens, delete webhooks, etc.

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error disconnecting integration:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

