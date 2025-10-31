import { NextRequest, NextResponse } from "next/server"
import { requireAuth, createInternalError, securityHeaders } from "@/lib/api-utils"
import { safeDb } from "@/lib/db-safety"
import { z } from "zod"

const createChannelSchema = z.object({
  name: z.string().min(1, "Channel name is required"),
  topic: z.string().min(1, "Topic is required"),
  authorized_users: z.array(z.string()).optional(),
  settings: z.object({
    presence_enabled: z.boolean().default(true),
    broadcast_enabled: z.boolean().default(true),
    postgres_changes_enabled: z.boolean().default(true),
    max_connections: z.number().optional()
  }).optional()
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const topic = searchParams.get('topic')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100)
    const offset = parseInt(searchParams.get('offset') || '0')

    let query = `
      SELECT id, name, topic, authorized_users, settings, created_at, updated_at
      FROM realtime_channels 
      WHERE deleted_at IS NULL
    `
    const params: any[] = []

    if (topic) {
      query += ` AND topic ILIKE $${params.length + 1}`
      params.push(`%${topic}%`)
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(limit, offset)

    const result = await safeDb.safeSelect(query, params)

    // Filter channels based on access permissions
    const accessibleChannels = result.rows.filter((channel: any) => {
      if (!channel.authorized_users || channel.authorized_users.length === 0) {
        return true // Public channel
      }
      return channel.authorized_users.includes(auth.user.id)
    })

    return NextResponse.json({
      channels: accessibleChannels,
      total: accessibleChannels.length
    }, {
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error fetching realtime channels:", error)
    return createInternalError("Failed to fetch channels")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth()
    if (!auth.success) {
      return auth.error
    }

    const body = await request.json()
    const validation = createChannelSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json({
        code: "VALIDATION_ERROR",
        message: "Invalid channel data",
        errors: validation.error.errors
      }, { 
        status: 400,
        headers: securityHeaders()
      })
    }

    const { name, topic, authorized_users, settings } = validation.data
    const channelId = `channel_${Date.now()}_${Math.random().toString(36).substring(2)}`

    const result = await safeDb.safeInsert(`
      INSERT INTO realtime_channels (id, name, topic, authorized_users, settings, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, name, topic, authorized_users, settings, created_at
    `, [
      channelId,
      name,
      topic,
      JSON.stringify(authorized_users || []),
      JSON.stringify(settings || {
        presence_enabled: true,
        broadcast_enabled: true,
        postgres_changes_enabled: true
      })
    ])

    return NextResponse.json({
      success: true,
      channel: result.rows[0]
    }, {
      status: 201,
      headers: securityHeaders()
    })

  } catch (error: any) {
    console.error("Error creating realtime channel:", error)
    return createInternalError("Failed to create channel")
  }
}