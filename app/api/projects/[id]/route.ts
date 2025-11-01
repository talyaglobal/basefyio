import { type NextRequest, NextResponse } from "next/server"
import { requireScopesWithRateLimit, createInternalError, securityHeaders } from "@/lib/api-utils"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

// GET /api/projects/[id] - Get a specific project
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const projectId = params.id

    // Check if user has access to this project's team
    const [project] = await sql`
      SELECT p.id, p.name, p.org_id, p.description, p.database_url, p.created_at, p.updated_at
      FROM projects p
      JOIN organizations o ON o.id = p.org_id
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE p.id = ${projectId} AND (o.owner_id = ${auth.user.id} OR om.user_id = ${auth.user.id})
      LIMIT 1
    `

    if (!project) {
      return NextResponse.json({ error: "Project not found or access denied" }, { status: 404, headers: securityHeaders })
    }

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
      { headers: securityHeaders }
    )
  } catch (error: any) {
    console.error("Error fetching project:", error)
    return createInternalError(error)
  }
}

// PUT /api/projects/[id] - Update a project
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const projectId = params.id
    const body = await request.json()
    const { name, description } = body

    // Check if user has access to this project's team
    const [project] = await sql`
      SELECT p.id, p.org_id
      FROM projects p
      JOIN organizations o ON o.id = p.org_id
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE p.id = ${projectId} AND (o.owner_id = ${auth.user.id} OR (om.user_id = ${auth.user.id} AND om.role IN ('admin', 'member')))
      LIMIT 1
    `

    if (!project) {
      return NextResponse.json({ error: "Project not found or access denied" }, { status: 404, headers: securityHeaders })
    }

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "Project name is required" }, { status: 400, headers: securityHeaders })
    }

    // Update project
    const [updated] = await sql`
      UPDATE projects
      SET name = ${name.trim()}, description = ${description || null}, updated_at = NOW()
      WHERE id = ${projectId}
      RETURNING id, name, org_id, description, database_url, created_at, updated_at
    `

    return NextResponse.json(
      {
        project: {
          id: updated.id,
          name: updated.name,
          org_id: updated.org_id,
          description: updated.description,
          database_url: updated.database_url,
          created_at: updated.created_at,
          updated_at: updated.updated_at,
        },
      },
      { headers: securityHeaders }
    )
  } catch (error: any) {
    console.error("Error updating project:", error)
    return createInternalError(error)
  }
}

// DELETE /api/projects/[id] - Delete a project
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const projectId = params.id

    // Check if user has access (owner or admin)
    const [project] = await sql`
      SELECT p.id, p.org_id
      FROM projects p
      JOIN organizations o ON o.id = p.org_id
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE p.id = ${projectId} AND (o.owner_id = ${auth.user.id} OR (om.user_id = ${auth.user.id} AND om.role = 'admin'))
      LIMIT 1
    `

    if (!project) {
      return NextResponse.json({ error: "Project not found or access denied" }, { status: 404, headers: securityHeaders })
    }

    // Delete project (cascade will handle related records)
    await sql`
      DELETE FROM projects WHERE id = ${projectId}
    `

    return NextResponse.json({ success: true }, { headers: securityHeaders })
  } catch (error: any) {
    console.error("Error deleting project:", error)
    return createInternalError(error)
  }
}

