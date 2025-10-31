import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody, 
  validateSearchParams,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { quotaMonitor } from "@/lib/quota-monitor"
import { z } from "zod"

const createAlertChannelSchema = z.object({
  type: z.enum(['webhook', 'email', 'slack']),
  config: z.object({
    url: z.string().url().optional(),
    email: z.string().email().optional(),
    slackChannel: z.string().optional(),
    headers: z.record(z.string()).optional(),
  }),
  events: z.array(z.enum(['quota_warning', 'quota_critical', 'quota_exceeded'])),
  enabled: z.boolean().default(true),
}).refine((data) => {
  if (data.type === 'webhook' && !data.config.url) {
    return false
  }
  if (data.type === 'email' && !data.config.email) {
    return false
  }
  if (data.type === 'slack' && !data.config.slackChannel) {
    return false
  }
  return true
}, {
  message: "Invalid configuration for alert channel type",
})

const getAlertChannelsSchema = z.object({
  type: z.enum(['webhook', 'email', 'slack']).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:quotas"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const validation = validateSearchParams(searchParams, getAlertChannelsSchema)
    if (!validation.success) {
      return validation.error
    }

    // In a real implementation, you'd fetch from database
    // For now, return a placeholder response
    return NextResponse.json({
      alertChannels: [],
      message: "Alert channels endpoint implemented"
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching alert channels:", error)
    return createInternalError("Failed to fetch alert channels")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:quotas"])
    if (!auth.success) {
      return auth.error
    }

    const validation = await validateRequestBody(request, createAlertChannelSchema)
    if (!validation.success) {
      return validation.error
    }

    const channelData = validation.data

    const channelId = await quotaMonitor.createAlertChannel(auth.user.id, {
      type: channelData.type,
      config: channelData.config,
      events: channelData.events,
      enabled: channelData.enabled ?? true,
    })

    return NextResponse.json({
      success: true,
      channelId,
      message: "Alert channel created successfully"
    }, {
      status: 201,
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error creating alert channel:", error)
    return createInternalError("Failed to create alert channel")
  }
}