import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(request: NextRequest) {
  try {
    const user = await getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get team and project from query params if provided
    const url = new URL(request.url)
    const teamId = url.searchParams.get("team_id")
    const projectId = url.searchParams.get("project_id")

    let integrations
    if (teamId && projectId) {
      integrations = await sql`
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
        WHERE user_id = ${user.id}
          AND (team_id = ${teamId} OR team_id IS NULL)
          AND (project_id = ${projectId} OR project_id IS NULL)
        ORDER BY connected_at DESC
      `
    } else {
      integrations = await sql`
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
        WHERE user_id = ${user.id}
        ORDER BY connected_at DESC
      `
    }

    return NextResponse.json({
      integrations: integrations.map((i) => ({
        ...i,
        config: i.config || {},
      })),
    })
  } catch (error) {
    console.error("Error fetching integrations:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

