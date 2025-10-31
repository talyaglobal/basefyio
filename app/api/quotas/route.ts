import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { quotaManager } from "@/lib/resource-quotas"
import { z } from "zod"

const updateQuotaSchema = z.object({
  userId: z.string().uuid().optional(), // For admin use only
  database: z.object({
    maxSize: z.number().min(0).optional(),
    maxTables: z.number().min(0).optional(),
    maxConnections: z.number().min(0).optional(),
    maxQueryTime: z.number().min(0).optional(),
  }).optional(),
  storage: z.object({
    maxSize: z.number().min(0).optional(),
    maxFiles: z.number().min(0).optional(),
    maxFileSize: z.number().min(0).optional(),
  }).optional(),
  api: z.object({
    maxRequestsPerHour: z.number().min(0).optional(),
    maxRequestsPerDay: z.number().min(0).optional(),
    maxConcurrentRequests: z.number().min(0).optional(),
  }).optional(),
  backup: z.object({
    maxBackups: z.number().min(0).optional(),
    maxBackupSize: z.number().min(0).optional(),
    retentionDays: z.number().min(1).optional(),
  }).optional(),
  features: z.object({
    enableReplicas: z.boolean().optional(),
    enablePITR: z.boolean().optional(),
    enableWebhooks: z.boolean().optional(),
    enableMigrations: z.boolean().optional(),
  }).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const targetUserId = searchParams.get('userId')

    // Admin can view any user's quotas, regular users can only view their own
    let userId = auth.user.id
    if (targetUserId) {
      if (auth.user.authMethod !== "session" || auth.user.email !== "admin@kolaybase.com") {
        return NextResponse.json({
          code: "INSUFFICIENT_PERMISSIONS",
          message: "Only admins can view other users' quotas"
        }, { 
          status: 403,
          headers: {
            ...securityHeaders(),
            ...auth.rateLimitHeaders,
          }
        })
      }
      userId = targetUserId
    }

    const [quota, usage] = await Promise.all([
      quotaManager.getUserQuota(userId),
      quotaManager.getCurrentUsage(userId),
    ])

    return NextResponse.json({
      quota,
      usage,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching quota:", error)
    return createInternalError("Failed to fetch quota information")
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Only admins can modify quotas
    if (auth.user.authMethod !== "session" || auth.user.email !== "admin@kolaybase.com") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Only admins can modify quotas"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const validation = await validateRequestBody(request, updateQuotaSchema)
    if (!validation.success) {
      return validation.error
    }

    const quotaUpdate = validation.data
    const targetUserId = quotaUpdate.userId || auth.user.id

    // Update quota
    await quotaManager.setUserQuota(targetUserId, quotaUpdate as any)

    // Get updated quota
    const updatedQuota = await quotaManager.getUserQuota(targetUserId)

    return NextResponse.json({
      success: true,
      quota: updatedQuota,
      message: "Quota updated successfully",
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error updating quota:", error)
    return createInternalError("Failed to update quota")
  }
}