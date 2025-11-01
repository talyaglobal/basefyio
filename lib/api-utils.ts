import { NextResponse } from "next/server"
import { z } from "zod"
import { getUser, type User } from "./auth"
import { hasScope, checkScopePermissions, type ApiScope } from "./api-key-utils"
import { rateLimitByIp, rateLimitByApiKey, type RateLimitResult } from "./rate-limit"
import { dynamicConnectionManager } from "./dynamic-connection-manager"
import { safeDb as defaultSafeDb } from "./db-safety"
import { neon } from "@neondatabase/serverless"

export interface ApiError {
  code: string
  message: string
  details?: Record<string, any>
}

export function createErrorResponse(
  error: ApiError,
  status: number = 400
): NextResponse {
  return NextResponse.json(error, { status })
}

export function createValidationError(errors: z.ZodError): NextResponse {
  return createErrorResponse(
    {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: {
        errors: errors.errors.map((err) => ({
          path: err.path,
          message: err.message,
          code: err.code,
        })),
      },
    },
    422
  )
}

export function createAuthError(): NextResponse {
  return createErrorResponse(
    {
      code: "UNAUTHORIZED",
      message: "Authentication required",
    },
    401
  )
}

export function createForbiddenError(): NextResponse {
  return createErrorResponse(
    {
      code: "FORBIDDEN",
      message: "Insufficient permissions",
    },
    403
  )
}

export function createNotFoundError(resource: string = "Resource"): NextResponse {
  return createErrorResponse(
    {
      code: "NOT_FOUND",
      message: `${resource} not found`,
    },
    404
  )
}

export function createRateLimitError(): NextResponse {
  return createErrorResponse(
    {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Rate limit exceeded",
    },
    429
  )
}

export function createInternalError(message?: string): NextResponse {
  return createErrorResponse(
    {
      code: "INTERNAL_ERROR",
      message: message || "An internal error occurred",
    },
    500
  )
}

export async function validateRequestBody<T>(
  request: Request,
  schema: z.ZodSchema<T>
): Promise<{ success: true; data: T } | { success: false; error: NextResponse }> {
  try {
    const body = await request.json()
    const result = schema.safeParse(body)
    
    if (!result.success) {
      return { success: false, error: createValidationError(result.error) }
    }
    
    return { success: true, data: result.data }
  } catch (error) {
    return {
      success: false,
      error: createErrorResponse(
        {
          code: "INVALID_JSON",
          message: "Invalid JSON in request body",
        },
        400
      ),
    }
  }
}

export function validateSearchParams<T>(
  searchParams: URLSearchParams,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: NextResponse } {
  const params = Object.fromEntries(searchParams.entries())
  const result = schema.safeParse(params)
  
  if (!result.success) {
    return { success: false, error: createValidationError(result.error) }
  }
  
  return { success: true, data: result.data }
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  }
}

export function securityHeaders() {
  // OAuth providers
  const oauthDomains = [
    "https://github.com",
    "https://api.github.com",
    "https://accounts.google.com",
    "https://oauth2.googleapis.com",
    "https://openidconnect.googleapis.com",
  ].join(" ")

  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": `default-src 'self'; connect-src 'self' ${oauthDomains}; frame-src ${oauthDomains}; frame-ancestors 'none'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline';`,
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  }
}

export async function requireAuth(): Promise<{ success: true; user: User } | { success: false; error: NextResponse }> {
  const user = await getUser()
  if (!user) {
    return { success: false, error: createAuthError() }
  }
  return { success: true, user }
}

export async function requireScopes(
  requiredScopes: ApiScope[], 
  endpoint?: string, 
  method?: string
): Promise<{ success: true; user: User } | { success: false; error: NextResponse }> {
  const auth = await requireAuth()
  if (!auth.success) {
    return auth
  }

  const user = auth.user

  // Session auth has full access
  if (user.authMethod === "session") {
    return { success: true, user }
  }

  // Check API key scopes
  if (user.authMethod === "api_key" && user.apiKeyScopes) {
    // If specific scopes are provided, check those
    if (requiredScopes.length > 0) {
      for (const scope of requiredScopes) {
        if (!hasScope(user.apiKeyScopes, scope)) {
          return {
            success: false,
            error: createForbiddenError()
          }
        }
      }
    }
    
    // If endpoint and method are provided, check endpoint-specific scopes
    if (endpoint && method) {
      const endpointScopes = checkScopePermissions(endpoint, method)
      for (const scope of endpointScopes) {
        if (!hasScope(user.apiKeyScopes, scope)) {
          return {
            success: false,
            error: createForbiddenError()
          }
        }
      }
    }
  }

  return { success: true, user }
}

export async function requireAuthWithRateLimit(request: Request): Promise<
  | { success: true; user: User; rateLimitHeaders: Record<string, string> }
  | { success: false; error: NextResponse }
> {
  // Check rate limit first
  let rateLimit: RateLimitResult
  
  try {
    const user = await getUser()
    
    if (user?.authMethod === "api_key") {
      // Rate limit by API key
      rateLimit = await rateLimitByApiKey(user.id)
    } else {
      // Rate limit by IP
      rateLimit = await rateLimitByIp(request)
    }
    
    const rateLimitHeaders = {
      "X-RateLimit-Limit": rateLimit.limit.toString(),
      "X-RateLimit-Remaining": rateLimit.remaining.toString(),
      "X-RateLimit-Reset": Math.floor(rateLimit.resetTime / 1000).toString(),
    }
    
    if (!rateLimit.allowed) {
      return {
        success: false,
        error: NextResponse.json(
          {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Rate limit exceeded",
          },
          {
            status: 429,
            headers: {
              ...securityHeaders(),
              ...rateLimitHeaders,
            },
          }
        ),
      }
    }
    
    if (!user) {
      return {
        success: false,
        error: NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "Authentication required",
          },
          {
            status: 401,
            headers: {
              ...securityHeaders(),
              ...rateLimitHeaders,
            },
          }
        ),
      }
    }
    
    return { success: true, user, rateLimitHeaders }
  } catch (error) {
    console.error("Auth/rate limit error:", error)
    return {
      success: false,
      error: createInternalError("Authentication failed")
    }
  }
}

export async function requireScopesWithRateLimit(
  request: Request,
  requiredScopes: ApiScope[], 
  endpoint?: string, 
  method?: string
): Promise<
  | { success: true; user: User; rateLimitHeaders: Record<string, string> }
  | { success: false; error: NextResponse }
> {
  const authResult = await requireAuthWithRateLimit(request)
  if (!authResult.success) {
    return authResult
  }

  const user = authResult.user

  // Session auth has full access
  if (user.authMethod === "session") {
    return authResult
  }

  // Check API key scopes
  if (user.authMethod === "api_key" && user.apiKeyScopes) {
    // If specific scopes are provided, check those
    if (requiredScopes.length > 0) {
      for (const scope of requiredScopes) {
        if (!hasScope(user.apiKeyScopes, scope)) {
          return {
            success: false,
            error: NextResponse.json(
              {
                code: "FORBIDDEN",
                message: "Insufficient permissions",
              },
              {
                status: 403,
                headers: {
                  ...securityHeaders(),
                  ...authResult.rateLimitHeaders,
                },
              }
            ),
          }
        }
      }
    }
    
    // If endpoint and method are provided, check endpoint-specific scopes
    if (endpoint && method) {
      const endpointScopes = checkScopePermissions(endpoint, method)
      for (const scope of endpointScopes) {
        if (!hasScope(user.apiKeyScopes, scope)) {
          return {
            success: false,
            error: NextResponse.json(
              {
                code: "FORBIDDEN",
                message: "Insufficient permissions",
              },
              {
                status: 403,
                headers: {
                  ...securityHeaders(),
                  ...authResult.rateLimitHeaders,
                },
              }
            ),
          }
        }
      }
    }
  }

  return authResult
}

/**
 * Get database connection based on database_id
 * This function retrieves the database URL and ensures the connection is registered
 */
export async function getDatabaseConnection(databaseId?: string | null): Promise<{
  safeDb: any
  sql: any
}> {
  if (!databaseId) {
    // Use default database connection
    return {
      safeDb: defaultSafeDb,
      sql: neon(process.env.DATABASE_URL!),
    }
  }

  // Check if database is already registered
  if (!dynamicConnectionManager.isRegistered(databaseId)) {
    // Need to fetch database metadata from the default database
    const dbMetadata = await defaultSafeDb.safeSelect(
      `SELECT id, database_url, provider FROM databases WHERE id = $1 AND status = 'active'`,
      [databaseId]
    )

    if (dbMetadata.rows.length === 0) {
      console.warn(`Database ${databaseId} not found, using default connection`)
      return {
        safeDb: defaultSafeDb,
        sql: neon(process.env.DATABASE_URL!),
      }
    }

    const db = dbMetadata.rows[0]
    await dynamicConnectionManager.registerDatabase(
      databaseId,
      db.database_url,
      db.provider
    )
  }

  return {
    safeDb: dynamicConnectionManager.getSafeDatabase(databaseId),
    sql: dynamicConnectionManager.getSQL(databaseId),
  }
}