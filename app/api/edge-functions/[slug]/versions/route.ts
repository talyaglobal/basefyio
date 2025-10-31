import { NextRequest, NextResponse } from "next/server"
import { requireAuth, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"

export const runtime = 'nodejs'

// Get all versions of a function
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const result = await safeDb.safeSelect(`
      SELECT id, name, slug, description, runtime, timeout_ms, memory_limit_mb,
             is_active, version, created_at, updated_at, deployed_at
      FROM edge_functions 
      WHERE slug = $1 AND created_by = $2
      ORDER BY version DESC
    `, [slug, auth.user.id])

    return NextResponse.json({
      versions: result.rows,
      total: result.rows.length
    }, {
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error fetching function versions:", error)
    return createInternalError("Failed to fetch versions")
  }
}

// Rollback to a specific version
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const body = await request.json()
    const targetVersion = body.version

    if (!targetVersion || typeof targetVersion !== 'number') {
      return NextResponse.json({
        code: "VALIDATION_ERROR",
        message: "Version number is required"
      }, {
        status: 400,
        headers: securityHeaders()
      })
    }

    // Get the target version
    const versionResult = await safeDb.safeSelect(`
      SELECT id, version FROM edge_functions 
      WHERE slug = $1 AND created_by = $2 AND version = $3
    `, [slug, auth.user.id, targetVersion])

    if (versionResult.rows.length === 0) {
      return NextResponse.json({
        code: "VERSION_NOT_FOUND",
        message: "Specified version not found"
      }, {
        status: 404,
        headers: securityHeaders()
      })
    }

    // Deactivate all versions
    await safeDb.safeUpdate(`
      UPDATE edge_functions 
      SET is_active = FALSE 
      WHERE slug = $1 AND created_by = $2
    `, [slug, auth.user.id])

    // Activate target version
    await safeDb.safeUpdate(`
      UPDATE edge_functions 
      SET is_active = TRUE, deployed_at = NOW()
      WHERE slug = $1 AND created_by = $2 AND version = $3
    `, [slug, auth.user.id, targetVersion])

    return NextResponse.json({
      success: true,
      message: `Rolled back to version ${targetVersion}`
    }, {
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error rolling back function:", error)
    return createInternalError("Failed to rollback function")
  }
}

