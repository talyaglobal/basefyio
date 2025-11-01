import { type NextRequest, NextResponse } from "next/server"
import { requireScopesWithRateLimit, createInternalError, securityHeaders } from "@/lib/api-utils"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

// GET /api/teams - Get all teams for the current user
export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    // Get teams where user is owner or member
    const teams = await sql`
      SELECT DISTINCT o.id, o.name, o.slug, o.owner_id, o.created_at, o.updated_at
      FROM organizations o
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE o.owner_id = ${auth.user.id} OR om.user_id = ${auth.user.id}
      ORDER BY o.created_at DESC
    `

    return NextResponse.json(
      {
        teams: teams.map((t: any) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          owner_id: t.owner_id,
          created_at: t.created_at,
          updated_at: t.updated_at,
        })),
      },
      { headers: securityHeaders() }
    )
  } catch (error: any) {
    console.error("Error fetching teams:", error)
    return createInternalError(error)
  }
}

// POST /api/teams - Create a new team
export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const body = await request.json()
    const { name } = body

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Team name is required" }, { status: 400, headers: securityHeaders() })
    }

    // Generate slug from name
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")

    // Check if slug already exists
    const existing = await sql`
      SELECT id FROM organizations WHERE slug = ${slug}
    `

    if (existing.length > 0) {
      return NextResponse.json({ error: "Team with this name already exists" }, { status: 409, headers: securityHeaders() })
    }

    // Create team
    const [team] = await sql`
      INSERT INTO organizations (name, slug, owner_id)
      VALUES (${name.trim()}, ${slug}, ${auth.user.id})
      RETURNING id, name, slug, owner_id, created_at, updated_at
    `

    // Add owner as member with admin role
    await sql`
      INSERT INTO organization_memberships (organization_id, user_id, role)
      VALUES (${team.id}, ${auth.user.id}, 'admin')
      ON CONFLICT (organization_id, user_id) DO NOTHING
    `

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
      { status: 201, headers: securityHeaders() }
    )
  } catch (error: any) {
    console.error("Error creating team:", error)
    return createInternalError(error)
  }
}

