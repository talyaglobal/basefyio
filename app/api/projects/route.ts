import { type NextRequest, NextResponse } from "next/server"
import { requireScopesWithRateLimit, createInternalError, securityHeaders } from "@/lib/api-utils"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

// GET /api/projects - Get all projects for a team
export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const teamId = searchParams.get("team_id")

    if (!teamId) {
      return NextResponse.json({ error: "team_id parameter is required" }, { status: 400, headers: securityHeaders })
    }

    // Check if user has access to this team
    const [team] = await sql`
      SELECT id FROM organizations o
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE o.id = ${teamId} AND (o.owner_id = ${auth.user.id} OR om.user_id = ${auth.user.id})
      LIMIT 1
    `

    if (!team) {
      return NextResponse.json({ error: "Team not found or access denied" }, { status: 404, headers: securityHeaders })
    }

    // Get projects for this team
    const projects = await sql`
      SELECT id, name, org_id, description, database_url, created_at, updated_at
      FROM projects
      WHERE org_id = ${teamId}
      ORDER BY created_at DESC
    `

    return NextResponse.json(
      {
        projects: projects.map((p: any) => ({
          id: p.id,
          name: p.name,
          org_id: p.org_id,
          description: p.description,
          database_url: p.database_url,
          created_at: p.created_at,
          updated_at: p.updated_at,
        })),
      },
      { headers: securityHeaders }
    )
  } catch (error: any) {
    console.error("Error fetching projects:", error)
    return createInternalError(error)
  }
}

// POST /api/projects - Create a new project
export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const body = await request.json()
    const { name, team_id, description } = body

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Project name is required" }, { status: 400, headers: securityHeaders })
    }

    if (!team_id) {
      return NextResponse.json({ error: "team_id is required" }, { status: 400, headers: securityHeaders })
    }

    // Check if user has access to this team
    const [team] = await sql`
      SELECT id FROM organizations o
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE o.id = ${team_id} AND (o.owner_id = ${auth.user.id} OR om.user_id = ${auth.user.id})
      LIMIT 1
    `

    if (!team) {
      return NextResponse.json({ error: "Team not found or access denied" }, { status: 404, headers: securityHeaders })
    }

    // Create project
    const [project] = await sql`
      INSERT INTO projects (name, org_id, description)
      VALUES (${name.trim()}, ${team_id}, ${description || null})
      RETURNING id, name, org_id, description, database_url, created_at, updated_at
    `

    return NextResponse.json(
      {
        project: {
          id: project.id,
          name: project.name,
          org_id: project.org_id,
          description: project.description,
          database_url: project.database_url,
          created_at: project.created_at,
          updated_at: project.updated_at,
        },
      },
      { status: 201, headers: securityHeaders }
    )
  } catch (error: any) {
    console.error("Error creating project:", error)
    return createInternalError(error)
  }
}

