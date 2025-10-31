import { NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { 
  requireAuth, 
  validateRequestBody, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { createApiKeySchema } from "@/lib/validation-schemas"
import { 
  generateApiKey, 
  hashApiKey, 
  validateScopes, 
  API_SCOPES,
  type ApiScope 
} from "@/lib/api-key-utils"

const sql = neon(process.env.DATABASE_URL!)

export async function GET() {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const keys = await sql`
      SELECT id, name, scopes, expires_at, created_at, last_used_at, is_active
      FROM api_keys
      WHERE user_id = ${auth.user.id}
      ORDER BY created_at DESC
    `

    return NextResponse.json({ 
      keys: keys.map(key => ({
        ...key,
        // Don't expose the actual key or hash
        scopes: key.scopes as ApiScope[],
      }))
    }, {
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error fetching API keys:", error)
    return createInternalError("Failed to fetch API keys")
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const validation = await validateRequestBody(request, createApiKeySchema)
    if (!validation.success) {
      return validation.error
    }

    const { name, scopes, expiresAt } = validation.data

    // Validate scopes
    const scopeValidation = validateScopes(scopes)
    if (!scopeValidation.valid) {
      return NextResponse.json({
        code: "INVALID_SCOPES",
        message: "Invalid scopes provided",
        details: {
          invalidScopes: scopeValidation.invalidScopes,
          availableScopes: Object.keys(API_SCOPES)
        }
      }, { status: 422 })
    }

    // Generate API key
    const apiKey = generateApiKey()
    const hashedKey = await hashApiKey(apiKey)

    const result = await sql`
      INSERT INTO api_keys (
        user_id, 
        name, 
        hashed_key, 
        scopes, 
        expires_at,
        is_active,
        created_at
      )
      VALUES (
        ${auth.user.id}, 
        ${name}, 
        ${hashedKey}, 
        ${JSON.stringify(scopeValidation.validScopes)},
        ${expiresAt ? new Date(expiresAt) : null},
        true,
        NOW()
      )
      RETURNING id, name, scopes, expires_at, created_at, is_active
    `

    return NextResponse.json({ 
      success: true, 
      apiKey: {
        ...result[0],
        scopes: result[0].scopes as ApiScope[],
      },
      token: apiKey // Only returned once
    }, {
      status: 201,
      headers: securityHeaders()
    })
  } catch (error) {
    console.error("Error creating API key:", error)
    return createInternalError("Failed to create API key")
  }
}
