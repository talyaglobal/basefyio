import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { quotaMonitor } from "@/lib/quota-monitor"

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Manual trigger for quota monitoring (admin only)
    const violations = await quotaMonitor.checkAllUserQuotas()

    return NextResponse.json({
      success: true,
      violationsDetected: violations.length,
      violations: violations.map(v => ({
        userId: v.userId,
        resource: v.resource,
        severity: v.severity,
        message: v.message,
        utilizationPercent: v.utilizationPercent
      }))
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error running quota monitoring:", error)
    return createInternalError("Failed to run quota monitoring")
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:quotas"])
    if (!auth.success) {
      return auth.error
    }

    // Check current user's quota status
    const violations = await quotaMonitor.checkUserQuotas(auth.user.id)

    return NextResponse.json({
      userId: auth.user.id,
      violationsDetected: violations.length,
      violations: violations.map(v => ({
        resource: v.resource,
        severity: v.severity,
        message: v.message,
        utilizationPercent: v.utilizationPercent,
        timestamp: v.timestamp
      })),
      summary: {
        critical: violations.filter(v => v.severity === 'critical').length,
        high: violations.filter(v => v.severity === 'high').length,
        medium: violations.filter(v => v.severity === 'medium').length,
        low: violations.filter(v => v.severity === 'low').length,
      }
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error checking user quota status:", error)
    return createInternalError("Failed to check quota status")
  }
}