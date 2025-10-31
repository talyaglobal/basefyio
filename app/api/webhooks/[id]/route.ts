import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  createNotFoundError,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { updateWebhookSchema } from "@/lib/validation-schemas"
import { safeDb } from "@/lib/db-safety"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:webhooks"])
    if (!auth.success) {
      return auth.error
    }

    const { id } = await params

    const result = await safeDb.safeSelect(`
      SELECT id, url, events, active, secret, headers, created_at, updated_at 
      FROM webhooks 
      WHERE id = $1 AND user_id = $2
    `, [id, auth.user.id])

    if (result.rows.length === 0) {
      return createNotFoundError("Webhook")
    }

    const webhook = {
      ...result.rows[0],
      events: JSON.parse(result.rows[0].events),
      headers: result.rows[0].headers ? JSON.parse(result.rows[0].headers) : null
    }

    return NextResponse.json({ webhook }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching webhook:", error)
    return createInternalError("Failed to fetch webhook")
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:webhooks"])
    if (!auth.success) {
      return auth.error
    }

    const { id } = await params
    const validation = await validateRequestBody(request, updateWebhookSchema)
    if (!validation.success) {
      return validation.error
    }

    const { url, events, secret, headers: customHeaders, active } = validation.data

    // Build dynamic update query
    const updateFields = []
    const values = []
    let paramIndex = 1

    if (url !== undefined) {
      updateFields.push(`url = $${paramIndex}`)
      values.push(url)
      paramIndex++
    }

    if (events !== undefined) {
      updateFields.push(`events = $${paramIndex}`)
      values.push(JSON.stringify(events))
      paramIndex++
    }

    if (secret !== undefined) {
      updateFields.push(`secret = $${paramIndex}`)
      values.push(secret)
      paramIndex++
    }

    if (customHeaders !== undefined) {
      updateFields.push(`headers = $${paramIndex}`)
      values.push(customHeaders ? JSON.stringify(customHeaders) : null)
      paramIndex++
    }

    if (active !== undefined) {
      updateFields.push(`active = $${paramIndex}`)
      values.push(active)
      paramIndex++
    }

    updateFields.push(`updated_at = NOW()`)

    // Add WHERE conditions
    values.push(id, auth.user.id)
    const whereClause = `WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}`

    const result = await safeDb.safeUpdate(`
      UPDATE webhooks 
      SET ${updateFields.join(', ')}
      ${whereClause}
      RETURNING id, url, events, active, secret, headers, created_at, updated_at
    `, values)

    if (result.rows.length === 0) {
      return createNotFoundError("Webhook")
    }

    const webhook = {
      ...result.rows[0],
      events: JSON.parse(result.rows[0].events),
      headers: result.rows[0].headers ? JSON.parse(result.rows[0].headers) : null
    }

    return NextResponse.json({ 
      success: true,
      webhook 
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error updating webhook:", error)
    return createInternalError("Failed to update webhook")
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:webhooks"])
    if (!auth.success) {
      return auth.error
    }

    const { id } = await params

    const result = await safeDb.safeDelete(`
      DELETE FROM webhooks 
      WHERE id = $1 AND user_id = $2
      RETURNING id
    `, [id, auth.user.id])

    if (result.rows.length === 0) {
      return createNotFoundError("Webhook")
    }

    return NextResponse.json({ 
      success: true,
      message: "Webhook deleted successfully"
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error deleting webhook:", error)
    return createInternalError("Failed to delete webhook")
  }
}
