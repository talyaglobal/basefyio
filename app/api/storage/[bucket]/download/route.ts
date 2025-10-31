import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { requireScopes, createNotFoundError, createInternalError, securityHeaders } from "@/lib/api-utils"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(request: NextRequest, { params }: { params: Promise<{ bucket: string }> }) {
  try {
    const auth = await requireScopes(["read:storage"], "/api/storage/:bucket/download", "GET")
    if (!auth.success) {
      return auth.error
    }

    const { bucket } = await params
    const { searchParams } = new URL(request.url)
    const path = (searchParams.get("path") || "").replace(/^\/+/, "")

    if (!path) {
      return createNotFoundError("File")
    }

    const files = await sql`
      SELECT id, name, size, type, url, key, created_at
      FROM storage_files
      WHERE user_id = ${auth.user.id}
        AND bucket = ${bucket}
        AND key = ${path}
      LIMIT 1
    `

    if (files.length === 0) {
      return createNotFoundError("File")
    }

    // Placeholder: return metadata as JSON; real implementation would stream the file
    return NextResponse.json({ file: files[0] }, { headers: securityHeaders() })
  } catch (error) {
    console.error("Error downloading bucket file:", error)
    return createInternalError("Failed to download file")
  }
}


