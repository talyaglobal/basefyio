import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { quotaMonitor } from "@/lib/quota-monitor"

type Severity = 'low' | 'medium' | 'high' | 'critical'

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:quotas"])
    if (!auth.success) {
      return auth.error
    }

    const userId = auth.user.id

    // Check current quotas for violations (this will also store them if found)
    const currentViolations = await quotaMonitor.checkUserQuotas(userId)

    // Get stored violations from database (includes acknowledged ones)
    const storedViolations = await quotaMonitor.getViolationsHistory(userId, 100)

    // Merge current violations with stored ones, preferring stored for acknowledged status
    const violationMap = new Map<string, typeof storedViolations[0]>()
    
    // Add stored violations first
    for (const violation of storedViolations) {
      violationMap.set(violation.id, violation)
    }

    // Add/update with current violations (merge with stored if exists)
    for (const violation of currentViolations) {
      const existing = violationMap.get(violation.id)
      if (existing) {
        // Update with latest data but keep acknowledged status
        violationMap.set(violation.id, {
          ...violation,
          acknowledged: existing.acknowledged,
          acknowledgedAt: existing.acknowledgedAt,
          acknowledgedBy: existing.acknowledgedBy,
        })
      } else {
        violationMap.set(violation.id, violation)
      }
    }

    // Convert to array and filter to show active violations (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const allViolations = Array.from(violationMap.values())
      .filter(v => new Date(v.timestamp) >= thirtyDaysAgo)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    // Format for UI
    const formattedViolations = allViolations.map(v => ({
      id: v.id,
      resource: v.resource as 'database' | 'storage' | 'api' | 'backup',
      severity: v.severity as Severity,
      message: v.message,
      utilizationPercent: v.utilizationPercent,
      timestamp: v.timestamp.toISOString(),
      acknowledged: v.acknowledged || false,
    }))

    const summary = formattedViolations.reduce(
      (acc, v) => {
        acc[v.severity] += 1
        return acc
      },
      { low: 0, medium: 0, high: 0, critical: 0 } as Record<Severity, number>
    )

    return NextResponse.json({
      violationsDetected: formattedViolations.length,
      violations: formattedViolations,
      summary,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching quota monitor:", error)
    return createInternalError("Failed to fetch quota monitor data")
  }
}