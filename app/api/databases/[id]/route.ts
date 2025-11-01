import { type NextRequest, NextResponse } from "next/server"
import { requireScopesWithRateLimit, createInternalError, securityHeaders } from "@/lib/api-utils"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

// GET /api/databases/[id] - Get a specific database
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { id: databaseId } = await params

    // Check if user has access to this database's project's team
    const [database] = await sql`
      SELECT d.id, d.project_id, d.name, d.description, d.database_url, d.provider, d.status, d.created_at, d.updated_at
      FROM databases d
      JOIN projects p ON p.id = d.project_id
      JOIN organizations o ON o.id = p.org_id
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE d.id = ${databaseId} AND (o.owner_id = ${auth.user.id} OR om.user_id = ${auth.user.id})
      LIMIT 1
    `

    if (!database) {
      return NextResponse.json({ error: "Database not found or access denied" }, { status: 404, headers: securityHeaders() })
    }

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
      { headers: securityHeaders() }
    )
  } catch (error: any) {
    console.error("Error fetching database:", error)
    return createInternalError(error)
  }
}

// PUT /api/databases/[id] - Update a database
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { id: databaseId } = await params
    const body = await request.json()
    const { name, description, database_url, status } = body

    // Check if user has access
    const [database] = await sql`
      SELECT d.id, d.project_id
      FROM databases d
      JOIN projects p ON p.id = d.project_id
      JOIN organizations o ON o.id = p.org_id
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE d.id = ${databaseId} AND (o.owner_id = ${auth.user.id} OR (om.user_id = ${auth.user.id} AND om.role IN ('admin', 'member')))
      LIMIT 1
    `

    if (!database) {
      return NextResponse.json({ error: "Database not found or access denied" }, { status: 404, headers: securityHeaders() })
    }

    // Build update query dynamically
    const updates: string[] = []
    const values: any[] = []

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json({ error: "Database name cannot be empty" }, { status: 400, headers: securityHeaders() })
      }
      updates.push(`name = $${values.length + 1}`)
      values.push(name.trim())
    }

    if (description !== undefined) {
      updates.push(`description = $${values.length + 1}`)
      values.push(description || null)
    }

    if (database_url !== undefined) {
      if (typeof database_url !== "string") {
        return NextResponse.json({ error: "database_url must be a string" }, { status: 400, headers: securityHeaders() })
      }
      updates.push(`database_url = $${values.length + 1}`)
      values.push(database_url)
    }

    if (status !== undefined) {
      if (!["active", "inactive", "maintenance"].includes(status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400, headers: securityHeaders() })
      }
      updates.push(`status = $${values.length + 1}`)
      values.push(status)
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400, headers: securityHeaders() })
    }

    // Update database using COALESCE to only update provided fields
    const [result] = await sql`
      UPDATE databases
      SET 
        name = COALESCE(${name || null}, name),
        description = COALESCE(${description !== undefined ? description : null}, description),
        database_url = COALESCE(${database_url || null}, database_url),
        status = COALESCE(${status || null}, status),
        updated_at = NOW()
      WHERE id = ${databaseId}
      RETURNING id, project_id, name, description, database_url, provider, status, created_at, updated_at
    `

    return NextResponse.json(
      {
        database: {
          id: result.id,
          project_id: result.project_id,
          name: result.name,
          description: result.description,
          database_url: result.database_url,
          provider: result.provider,
          status: result.status,
          created_at: result.created_at,
          updated_at: result.updated_at,
        },
      },
      { headers: securityHeaders() }
    )
  } catch (error: any) {
    console.error("Error updating database:", error)
    return createInternalError(error)
  }
}

// DELETE /api/databases/[id] - Delete a database
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { id: databaseId } = await params

    // Check if user has access (owner or admin)
    const [database] = await sql`
      SELECT d.id
      FROM databases d
      JOIN projects p ON p.id = d.project_id
      JOIN organizations o ON o.id = p.org_id
      LEFT JOIN organization_memberships om ON om.organization_id = o.id
      WHERE d.id = ${databaseId} AND (o.owner_id = ${auth.user.id} OR (om.user_id = ${auth.user.id} AND om.role = 'admin'))
      LIMIT 1
    `

    if (!database) {
      return NextResponse.json({ error: "Database not found or access denied" }, { status: 404, headers: securityHeaders() })
    }

    // Delete database
    await sql`
      DELETE FROM databases WHERE id = ${databaseId}
    `

    return NextResponse.json({ success: true }, { headers: securityHeaders() })
  } catch (error: any) {
    console.error("Error deleting database:", error)
    return createInternalError(error)
  }
}

