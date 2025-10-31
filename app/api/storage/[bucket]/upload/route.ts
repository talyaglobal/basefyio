import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { requireScopes, securityHeaders, createInternalError, createErrorResponse } from "@/lib/api-utils"

const sql = neon(process.env.DATABASE_URL!)

export async function POST(request: NextRequest, { params }: { params: Promise<{ bucket: string }> }) {
  try {
    const auth = await requireScopes(["write:storage"], "/api/storage/:bucket/upload", "POST")
    if (!auth.success) {
      return auth.error
    }

    const { bucket } = await params
    const { searchParams } = new URL(request.url)
    const path = (searchParams.get("path") || "").replace(/^\/+/, "")

    const formData = await request.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return createErrorResponse({ code: "MISSING_FILE", message: "No file provided" }, 400)
    }

    const key = `${path}${path && !path.endsWith("/") ? "/" : ""}${file.name}`.replace(/^\/+/, "")

    const result = await sql`
      INSERT INTO storage_files (user_id, bucket, key, name, size, type, url, created_at)
      VALUES (
        ${auth.user.id},
        ${bucket},
        ${key},
        ${file.name},
        ${file.size},
        ${file.type || "application/octet-stream"},
        ${`/uploads/${file.name}`},
        NOW()
      )
      RETURNING id, name, size, type, url, key, created_at
    `

    return NextResponse.json(
      { success: true, file: result[0] },
      { status: 201, headers: securityHeaders() }
    )
  } catch (error) {
    console.error("Error uploading bucket file:", error)
    return createInternalError("Failed to upload file")
  }
}


