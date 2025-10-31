import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { quotaMonitor } from "@/lib/quota-monitor"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["write:quotas"])
    if (!auth.success) {
      return auth.error
    }

    const { id: violationId } = await params

    if (!violationId || typeof violationId !== 'string') {
      return NextResponse.json(
        { error: "Invalid violation ID" },
        { 
          status: 400,
          headers: securityHeaders()
        }
      )
    }

    await quotaMonitor.acknowledgeViolation(
      violationId,
      auth.user.id,
      auth.user.id // In a real system, you might want to track who acknowledged it
    )

    return NextResponse.json({
      success: true,
      message: "Violation acknowledged successfully"
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error acknowledging quota violation:", error)
    return createInternalError("Failed to acknowledge violation")
  }
}