import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { quotaMonitor, DEFAULT_THRESHOLDS } from "@/lib/quota-monitor"
import { z } from "zod"

const thresholdSchema = z.object({
  resource: z.enum(['database', 'storage', 'api', 'backup']),
  metric: z.string(),
  warningThreshold: z.number().min(0).max(100),
  criticalThreshold: z.number().min(0).max(100),
  enabled: z.boolean()
}).refine((data) => data.criticalThreshold >= data.warningThreshold, {
  message: "Critical threshold must be greater than or equal to warning threshold",
})

const updateThresholdsSchema = z.object({
  thresholds: z.array(thresholdSchema)
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:quotas"])
    if (!auth.success) {
      return auth.error
    }

    // For now, return default thresholds
    // In a real implementation, you'd fetch user-specific thresholds from database
    return NextResponse.json({
      thresholds: DEFAULT_THRESHOLDS,
      message: "Using default quota thresholds"
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching quota thresholds:", error)
    return createInternalError("Failed to fetch quota thresholds")
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:quotas"])
    if (!auth.success) {
      return auth.error
    }

    const validation = await validateRequestBody(request, updateThresholdsSchema)
    if (!validation.success) {
      return validation.error
    }

    const { thresholds } = validation.data

    await quotaMonitor.updateUserThresholds(auth.user.id, thresholds)

    return NextResponse.json({
      success: true,
      message: "Quota thresholds updated successfully"
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error updating quota thresholds:", error)
    return createInternalError("Failed to update quota thresholds")
  }
}