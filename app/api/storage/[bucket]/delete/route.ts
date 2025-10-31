import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { requireScopes, createInternalError, createErrorResponse, securityHeaders } from "@/lib/api-utils"

const sql = neon(process.env.DATABASE_URL!)

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ bucket: string }> }) {
  try {
    const auth = await requireScopes(["write:storage"], "/api/storage/:bucket/delete", "DELETE")
    if (!auth.success) {
      return auth.error
    }

    const { bucket } = await params
    const body = await request.json().catch(() => ({} as any))
    const paths: string[] = Array.isArray(body?.paths) ? body.paths : []

    if (paths.length === 0) {
      return createErrorResponse({ code: "MISSING_PATHS", message: "No paths provided" }, 400)
    }

    await sql`
      DELETE FROM storage_files
      WHERE user_id = ${auth.user.id}
        AND bucket = ${bucket}
        AND key = ANY(${paths}::text[])
    `

    return NextResponse.json({ success: true }, { headers: securityHeaders() })
  } catch (error) {
    console.error("Error deleting bucket files:", error)
    return createInternalError("Failed to delete files")
  }
}


