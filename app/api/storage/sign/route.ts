import { NextRequest, NextResponse } from "next/server"
import { getUser } from "@/lib/auth"
import { generateSignedUrl, generateFileKey } from "@/lib/storage-utils"
import { 
  createAuthError, 
  createInternalError,
  validateRequestBody,
  securityHeaders
} from "@/lib/api-utils"
import { z } from "zod"

const signUrlSchema = z.object({
  fileName: z.string().min(1, "File name is required"),
  contentType: z.string().min(1, "Content type is required"),
  fileSize: z.number().min(1, "File size must be greater than 0"),
  method: z.enum(["GET", "POST", "PUT"]).default("POST"),
  expiresIn: z.number().min(60).max(3600).default(3600), // 1 minute to 1 hour
})

export async function POST(request: NextRequest) {
  try {
    const user = await getUser()
    if (!user) {
      return createAuthError()
    }

    const validation = await validateRequestBody(request, signUrlSchema)
    if (!validation.success) {
      return validation.error
    }

    const { fileName, contentType, fileSize, method, expiresIn } = validation.data

    // Generate unique file key
    const fileKey = generateFileKey(user.id, fileName)

    // Generate signed URL
    const signedUrl = generateSignedUrl({
      bucket: "default",
      key: fileKey,
      method,
      contentType,
      contentLength: fileSize,
      expiresIn,
    })

    return NextResponse.json({
      success: true,
      signedUrl: signedUrl.url,
      expiresAt: signedUrl.expiresAt,
      fileKey,
      fields: signedUrl.fields,
    }, {
      headers: securityHeaders(),
    })

  } catch (error) {
    console.error("Error generating signed URL:", error)
    return createInternalError("Failed to generate signed URL")
  }
}

const getSignedUrlSchema = z.object({
  fileKey: z.string().min(1, "File key is required"),
  expiresIn: z.number().min(60).max(3600).default(3600),
})

export async function GET(request: NextRequest) {
  try {
    const user = await getUser()
    if (!user) {
      return createAuthError()
    }

    const { searchParams } = new URL(request.url)
    const params = Object.fromEntries(searchParams.entries())
    
    const result = getSignedUrlSchema.safeParse(params)
    if (!result.success) {
      return NextResponse.json({
        code: "VALIDATION_ERROR",
        message: "Invalid parameters",
        details: { errors: result.error.errors },
      }, { status: 422 })
    }

    const { fileKey, expiresIn } = result.data

    // Generate signed URL for file access
    const signedUrl = generateSignedUrl({
      bucket: "default",
      key: fileKey,
      method: "GET",
      expiresIn,
    })

    return NextResponse.json({
      success: true,
      signedUrl: signedUrl.url,
      expiresAt: signedUrl.expiresAt,
    }, {
      headers: securityHeaders(),
    })

  } catch (error) {
    console.error("Error generating signed URL:", error)
    return createInternalError("Failed to generate signed URL")
  }
}