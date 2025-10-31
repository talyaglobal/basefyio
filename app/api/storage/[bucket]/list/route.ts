import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { requireScopes, securityHeaders, createInternalError } from "@/lib/api-utils"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(request: NextRequest, { params }: { params: Promise<{ bucket: string }> }) {
  try {
    const auth = await requireScopes(["read:storage"], "/api/storage/:bucket/list", "GET")
    if (!auth.success) {
      return auth.error
    }

    const { bucket } = await params
    const { searchParams } = new URL(request.url)
    const path = (searchParams.get("path") || "").replace(/^\/+/, "")

    const files = await sql`
      SELECT id, name, size, type, url, key, created_at
      FROM storage_files
      WHERE user_id = ${auth.user.id}
        AND bucket = ${bucket}
        AND (${path === "" ? sql`TRUE` : sql`key ILIKE ${path + '%'}`})
      ORDER BY created_at DESC
      LIMIT 100
    `

    return NextResponse.json({ files }, { headers: securityHeaders() })
  } catch (error) {
    console.error("Error listing bucket files:", error)
    return createInternalError("Failed to list files")
  }
}


