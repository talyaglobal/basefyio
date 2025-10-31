import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateSearchParams,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { quotaMonitor } from "@/lib/quota-monitor"
import { z } from "zod"

const getViolationsSchema = z.object({
  limit: z.string().optional().transform(val => val ? parseInt(val) : 50),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  acknowledged: z.string().optional().transform(val => val === 'true' ? true : val === 'false' ? false : undefined),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:quotas"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const validation = validateSearchParams(searchParams, getViolationsSchema as any)
    if (!validation.success) {
      return validation.error
    }

    const { limit, severity, acknowledged } = validation.data as any

    const violations = await quotaMonitor.getViolationsHistory(
      auth.user.id,
      limit,
      severity
    )

    // Filter by acknowledged status if specified
    const filteredViolations = acknowledged !== undefined 
      ? violations.filter(v => v.acknowledged === acknowledged)
      : violations

    return NextResponse.json({
      violations: filteredViolations,
      total: filteredViolations.length,
      summary: {
        critical: filteredViolations.filter(v => v.severity === 'critical').length,
        high: filteredViolations.filter(v => v.severity === 'high').length,
        medium: filteredViolations.filter(v => v.severity === 'medium').length,
        low: filteredViolations.filter(v => v.severity === 'low').length,
        acknowledged: filteredViolations.filter(v => v.acknowledged).length,
        unacknowledged: filteredViolations.filter(v => !v.acknowledged).length,
      }
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching quota violations:", error)
    return createInternalError("Failed to fetch quota violations")
  }
}