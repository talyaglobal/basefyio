import { type NextRequest, NextResponse } from "next/server"
import { requireScopesWithRateLimit, createInternalError, securityHeaders } from "@/lib/api-utils"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

// GET /api/teams/[id] - Get a specific team
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { id: teamId } = await params

    // Check if user has access to this team
    const [team] = await sql`
      SELECT o.id, o.name, o.slug, o.owner_id, o.created_at, o.updated_at
      FROM organizations o
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE o.id = ${teamId} AND (o.owner_id = ${auth.user.id} OR om.user_id = ${auth.user.id})
      LIMIT 1
    `

    if (!team) {
      return NextResponse.json({ error: "Team not found or access denied" }, { status: 404, headers: securityHeaders() })
    }

    return NextResponse.json(
      {
        team: {
          id: team.id,
          name: team.name,
          slug: team.slug,
          owner_id: team.owner_id,
          created_at: team.created_at,
          updated_at: team.updated_at,
        },
      },
      { headers: securityHeaders() }
    )
  } catch (error: any) {
    console.error("Error fetching team:", error)
    return createInternalError(error)
  }
}

// PUT /api/teams/[id] - Update a team
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { id: teamId } = await params
    const body = await request.json()
    const { name } = body

    // Check if user is owner or admin
    const [team] = await sql`
      SELECT o.id, o.owner_id
      FROM organizations o
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE o.id = ${teamId} AND (o.owner_id = ${auth.user.id} OR (om.user_id = ${auth.user.id} AND om.role = 'admin'))
      LIMIT 1
    `

    if (!team) {
      return NextResponse.json({ error: "Team not found or access denied" }, { status: 404, headers: securityHeaders() })
    }

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Team name is required" }, { status: 400, headers: securityHeaders() })
    }

    // Generate new slug
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")

    // Check if new slug conflicts
    const existing = await sql`
      SELECT id FROM organizations WHERE slug = ${slug} AND id != ${teamId}
    `

    if (existing.length > 0) {
      return NextResponse.json({ error: "Team with this name already exists" }, { status: 409, headers: securityHeaders() })
    }

    // Update team
    const [updated] = await sql`
      UPDATE organizations
      SET name = ${name.trim()}, slug = ${slug}, updated_at = NOW()
      WHERE id = ${teamId}
      RETURNING id, name, slug, owner_id, created_at, updated_at
    `

    return NextResponse.json(
      {
        team: {
          id: updated.id,
          name: updated.name,
          slug: updated.slug,
          owner_id: updated.owner_id,
          created_at: updated.created_at,
          updated_at: updated.updated_at,
        },
      },
      { headers: securityHeaders() }
    )
  } catch (error: any) {
    console.error("Error updating team:", error)
    return createInternalError(error)
  }
}

// DELETE /api/teams/[id] - Delete a team
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { id: teamId } = await params

    // Check if user is owner
    const [team] = await sql`
      SELECT id FROM organizations WHERE id = ${teamId} AND owner_id = ${auth.user.id}
    `

    if (!team) {
      return NextResponse.json({ error: "Team not found or access denied" }, { status: 404, headers: securityHeaders() })
    }

    // Delete team (cascade will handle related records)
    await sql`
      DELETE FROM organizations WHERE id = ${teamId}
    `

    return NextResponse.json({ success: true }, { headers: securityHeaders() })
  } catch (error: any) {
    console.error("Error deleting team:", error)
    return createInternalError(error)
  }
}

