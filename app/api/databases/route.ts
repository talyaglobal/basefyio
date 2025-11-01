import { type NextRequest, NextResponse } from "next/server"
import { requireScopesWithRateLimit, createInternalError, securityHeaders } from "@/lib/api-utils"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

// GET /api/databases - Get all databases for a project
export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get("project_id")

    if (!projectId) {
      return NextResponse.json({ error: "project_id parameter is required" }, { status: 400, headers: securityHeaders() })
    }

    // Check if user has access to this project's team
    const [project] = await sql`
      SELECT p.id
      FROM projects p
      JOIN organizations o ON o.id = p.org_id
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE p.id = ${projectId} AND (o.owner_id = ${auth.user.id} OR om.user_id = ${auth.user.id})
      LIMIT 1
    `

    if (!project) {
      return NextResponse.json({ error: "Project not found or access denied" }, { status: 404, headers: securityHeaders() })
    }

    // Get databases for this project
    const databases = await sql`
      SELECT id, project_id, name, description, database_url, provider, status, created_at, updated_at
      FROM databases
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC
    `

    return NextResponse.json(
      {
        databases: databases.map((d: any) => ({
          id: d.id,
          project_id: d.project_id,
          name: d.name,
          description: d.description,
          database_url: d.database_url,
          provider: d.provider,
          status: d.status,
          created_at: d.created_at,
          updated_at: d.updated_at,
        })),
      },
      { headers: securityHeaders() }
    )
  } catch (error: any) {
    console.error("Error fetching databases:", error)
    return createInternalError(error)
  }
}

// POST /api/databases - Create a new database
export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const body = await request.json()
    const { name, project_id, description, database_url, provider = "postgres" } = body

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Database name is required" }, { status: 400, headers: securityHeaders() })
    }

    if (!project_id) {
      return NextResponse.json({ error: "project_id is required" }, { status: 400, headers: securityHeaders() })
    }

    if (!database_url || typeof database_url !== "string") {
      return NextResponse.json({ error: "database_url is required" }, { status: 400, headers: securityHeaders() })
    }

    // Check if user has access to this project's team
    const [project] = await sql`
      SELECT p.id
      FROM projects p
      JOIN organizations o ON o.id = p.org_id
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE p.id = ${project_id} AND (o.owner_id = ${auth.user.id} OR om.user_id = ${auth.user.id})
      LIMIT 1
    `

    if (!project) {
      return NextResponse.json({ error: "Project not found or access denied" }, { status: 404, headers: securityHeaders() })
    }

    // Check if database name already exists in this project
    const existing = await sql`
      SELECT id FROM databases WHERE project_id = ${project_id} AND name = ${name.trim()}
    `

    if (existing.length > 0) {
      return NextResponse.json({ error: "Database with this name already exists in this project" }, { status: 409, headers: securityHeaders() })
    }

    // Create database
    const [database] = await sql`
      INSERT INTO databases (project_id, name, description, database_url, provider)
      VALUES (${project_id}, ${name.trim()}, ${description || null}, ${database_url}, ${provider})
      RETURNING id, project_id, name, description, database_url, provider, status, created_at, updated_at
    `

    return NextResponse.json(
      {
        database: {
          id: database.id,
          project_id: database.project_id,
          name: database.name,
          description: database.description,
          database_url: database.database_url,
          provider: database.provider,
          status: database.status,
          created_at: database.created_at,
          updated_at: database.updated_at,
        },
      },
      { status: 201, headers: securityHeaders() }
    )
  } catch (error: any) {
    console.error("Error creating database:", error)
    return createInternalError(error)
  }
}

