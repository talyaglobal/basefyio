import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody, 
  validateSearchParams,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { createWebhookSchema, paginationSchema } from "@/lib/validation-schemas"
import { safeDb } from "@/lib/db-safety"
import { PaginationBuilder } from "@/lib/pagination-utils"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:webhooks"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const validation = validateSearchParams(searchParams, paginationSchema)
    if (!validation.success) {
      return validation.error
    }

    const { limit, cursor } = validation.data

    const builder = new PaginationBuilder(
      safeDb,
      "webhooks",
      "SELECT id, name, url, events, active, created_at, updated_at FROM webhooks"
    )

    builder.where("user_id = $1", auth.user.id)

    const result = await builder.paginate({
      limit: limit || 20,
      cursor,
      sortBy: "created_at",
      sortOrder: "desc"
    })

    return NextResponse.json({
      webhooks: result.data,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching webhooks:", error)
    return createInternalError("Failed to fetch webhooks")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:webhooks"])
    if (!auth.success) {
      return auth.error
    }

    const validation = await validateRequestBody(request, createWebhookSchema)
    if (!validation.success) {
      return validation.error
    }

    const { url, events, secret, headers: customHeaders } = validation.data

    const result = await safeDb.safeInsert(`
      INSERT INTO webhooks (user_id, url, events, active, secret, headers, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING id, url, events, active, created_at, updated_at
    `, [
      auth.user.id,
      url,
      JSON.stringify(events),
      true,
      secret,
      customHeaders ? JSON.stringify(customHeaders) : null
    ])

    return NextResponse.json({ 
      success: true,
      webhook: {
        ...result.rows[0],
        events: JSON.parse(result.rows[0].events),
        headers: result.rows[0].headers ? JSON.parse(result.rows[0].headers) : null
      }
    }, {
      status: 201,
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error creating webhook:", error)
    return createInternalError("Failed to create webhook")
  }
}
