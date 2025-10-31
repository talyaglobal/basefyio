import { NextRequest, NextResponse } from "next/server"
import { requireScopes, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"
import { generateFileKey } from "@/lib/storage-utils"
import { quotaManager } from "@/lib/resource-quotas"

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopes(["write:storage"])
    if (!auth.success) {
      return auth.error
    }

    const formData = await request.formData()
    const file = formData.get("file") as File

    if (!file) {
      return NextResponse.json({
        code: "VALIDATION_ERROR",
        message: "No file provided"
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    // Check quota before uploading
    const quotaCheck = await quotaManager.checkQuotaViolation(
      auth.user.id,
      'storage',
      'create',
      file.size
    )

    if (!quotaCheck.allowed) {
      return NextResponse.json({
        code: "QUOTA_EXCEEDED",
        message: quotaCheck.message
      }, { 
        status: 403,
        headers: securityHeaders()
      })
    }

    // Generate file path/key
    const fileKey = generateFileKey(auth.user.id, file.name)
    
    // Get default bucket or create one
    let bucketResult = await safeDb.safeSelect(`
      SELECT id FROM storage_buckets WHERE name = 'default' LIMIT 1
    `)
    
    let bucketId: string
    if (bucketResult.rows.length === 0) {
      const newBucket = await safeDb.safeInsert(`
        INSERT INTO storage_buckets (name, public) 
        VALUES ('default', true) 
        RETURNING id
      `)
      bucketId = newBucket.rows[0].id
    } else {
      bucketId = bucketResult.rows[0].id
    }

    // In a real implementation, you would upload to a storage service like Vercel Blob
    // For now, we'll just store metadata with a placeholder URL
    const fileUrl = `/api/storage/files/${fileKey}`
    
    const result = await safeDb.safeInsert(`
      INSERT INTO storage_files (
        bucket_id, 
        name, 
        path, 
        size, 
        mime_type, 
        uploaded_by,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING 
        id, 
        name, 
        size, 
        mime_type as type,
        created_at,
        metadata
    `, [
      bucketId,
      file.name,
      fileKey,
      file.size,
      file.type || 'application/octet-stream',
      auth.user.id,
      JSON.stringify({ url: fileUrl })
    ])

    const fileRecord = result.rows[0]
    
    // Construct response matching component expectations
    return NextResponse.json({ 
      success: true, 
      file: {
        id: fileRecord.id,
        name: fileRecord.name,
        size: fileRecord.size,
        type: fileRecord.type,
        url: fileUrl,
        created_at: fileRecord.created_at
      }
    }, {
      headers: securityHeaders()
    })
  } catch (error: any) {
    console.error("Error uploading file:", error)
    return createInternalError("Failed to upload file")
  }
}
