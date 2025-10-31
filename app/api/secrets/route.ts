import { NextRequest, NextResponse } from "next/server"
import { requireAuth, createInternalError, securityHeaders } from "@/lib/api-utils"
import { secretsManager } from "@/lib/secrets-manager"
import { z } from "zod"

const createSecretSchema = z.object({
  name: z.string().min(1, "Secret name is required").regex(/^[A-Z0-9_]+$/, "Secret name must be uppercase letters, numbers, and underscores only"),
  value: z.string().min(1, "Secret value is required"),
  description: z.string().optional(),
  expires_at: z.string().datetime().optional()
})

const updateSecretSchema = z.object({
  value: z.string().min(1, "Secret value is required").optional(),
  description: z.string().optional(),
  expires_at: z.string().datetime().optional()
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
    const offset = parseInt(searchParams.get('offset') || '0')
    const includeExpired = searchParams.get('include_expired') === 'true'

    const secrets = await secretsManager.listSecrets(auth.user.id, {
      limit,
      offset,
      includeExpired
    })

    return NextResponse.json({
      secrets,
      total: secrets.length
    }, {
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error fetching secrets:", error)
    return createInternalError("Failed to fetch secrets")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const body = await request.json()
    const validation = createSecretSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json({
        code: "VALIDATION_ERROR",
        message: "Invalid secret data",
        errors: validation.error.errors
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    const { name, value, description, expires_at } = validation.data

    const secretId = await secretsManager.createSecret(name, value, auth.user.id, {
      description,
      expiresAt: expires_at ? new Date(expires_at) : undefined
    })

    return NextResponse.json({
      success: true,
      secret: {
        id: secretId,
        name,
        description,
        created_at: new Date().toISOString()
      }
    }, {
      status: 201,
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error creating secret:", error)
    
    if (error.message.includes('already exists')) {
      return NextResponse.json({
        code: "SECRET_EXISTS",
        message: error.message
      }, { 
        status: 409,
        headers: securityHeaders()
      })
    }

    return createInternalError("Failed to create secret")
  }
}