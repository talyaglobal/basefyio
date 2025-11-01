import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(
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
      SELECT id, provider, status, config
      FROM integrations
      WHERE id = ${id} AND user_id = ${user.id}
      LIMIT 1
    `

    if (integrations.length === 0) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 })
    }

    const integration = integrations[0]

    if (integration.status !== "connected") {
      return NextResponse.json({ error: "Integration is not connected" }, { status: 400 })
    }

    // Update sync status
    await sql`
      UPDATE integrations
      SET sync_status = 'syncing',
          updated_at = NOW()
      WHERE id = ${id}
    `

    // Create sync log entry
    const syncLogs = await sql`
      INSERT INTO integration_sync_logs (integration_id, sync_type, status)
      VALUES (${id}, 'manual', 'pending')
      RETURNING id
    `

    // TODO: Implement actual sync logic based on provider
    // This would call provider-specific APIs to sync data
    // For now, we'll simulate a sync
    setTimeout(async () => {
      try {
        // Simulate sync completion
        await sql`
          UPDATE integrations
          SET sync_status = 'success',
              last_sync_at = NOW(),
              sync_error = NULL,
              updated_at = NOW()
          WHERE id = ${id}
        `

        await sql`
          UPDATE integration_sync_logs
          SET status = 'success',
              completed_at = NOW(),
              items_synced = 1
          WHERE id = ${syncLogs[0].id}
        `
      } catch (error) {
        console.error("Error updating sync status:", error)
      }
    }, 2000)

    return NextResponse.json({
      success: true,
      message: "Sync started",
      sync_log_id: syncLogs[0].id,
    })
  } catch (error) {
    console.error("Error starting sync:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

