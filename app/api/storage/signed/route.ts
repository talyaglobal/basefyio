import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { getUser } from "@/lib/auth"
import { verifySignedUrl } from "@/lib/storage-utils"
import { 
  createAuthError, 
  createNotFoundError, 
  createInternalError,
  createErrorResponse,
  securityHeaders 
} from "@/lib/api-utils"

const sql = neon(process.env.DATABASE_URL!)

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    
    // Verify the signed URL
    const verification = verifySignedUrl(searchParams)
    
    if (!verification.valid) {
      return createErrorResponse(
        {
          code: verification.expired ? "URL_EXPIRED" : "INVALID_SIGNATURE",
          message: verification.error || "Invalid signed URL",
        },
        verification.expired ? 410 : 403
      )
    }

    const { bucket, key } = verification.payload

    // Get file from database
    const files = await sql`
      SELECT id, name, size, type, url, user_id, created_at
      FROM storage_files
      WHERE bucket = ${bucket} AND key = ${key}
      LIMIT 1
    `

    if (files.length === 0) {
      return createNotFoundError("File")
    }

    const file = files[0]

    // For now, since we don't have actual file storage implemented,
    // we'll return the file metadata and a placeholder URL
    return NextResponse.json({
      success: true,
      file: {
        id: file.id,
        name: file.name,
        size: file.size,
        type: file.type,
        url: file.url,
        created_at: file.created_at,
      },
    }, {
      headers: securityHeaders(),
    })

  } catch (error) {
    console.error("Error handling signed URL:", error)
    return createInternalError("Failed to process signed URL")
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getUser()
    if (!user) {
      return createAuthError()
    }

    const { searchParams } = new URL(request.url)
    
    // Verify the signed URL
    const verification = verifySignedUrl(searchParams)
    
    if (!verification.valid) {
      return createErrorResponse(
        {
          code: verification.expired ? "URL_EXPIRED" : "INVALID_SIGNATURE",
          message: verification.error || "Invalid signed URL",
        },
        verification.expired ? 410 : 403
      )
    }

    const { bucket, key, contentType } = verification.payload

    // Handle file upload via signed URL
    const formData = await request.formData()
    const file = formData.get("file") as File

    if (!file) {
      return createErrorResponse(
        {
          code: "MISSING_FILE",
          message: "No file provided in upload request",
        },
        400
      )
    }

    // Verify content type matches if specified
    if (contentType && file.type !== contentType) {
      return createErrorResponse(
        {
          code: "CONTENT_TYPE_MISMATCH",
          message: `Expected content type ${contentType}, got ${file.type}`,
        },
        400
      )
    }

    // Save file metadata to database
    const result = await sql`
      INSERT INTO storage_files (user_id, bucket, key, name, size, type, url, created_at)
      VALUES (
        ${user.id}, 
        ${bucket}, 
        ${key}, 
        ${file.name}, 
        ${file.size}, 
        ${file.type}, 
        ${`/api/storage/files/${key}`}, 
        NOW()
      )
      RETURNING id, name, size, type, url, created_at
    `

    return NextResponse.json({
      success: true,
      file: result[0],
    }, {
      status: 201,
      headers: securityHeaders(),
    })

  } catch (error) {
    console.error("Error handling signed upload:", error)
    return createInternalError("Failed to process file upload")
  }
}