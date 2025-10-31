import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { dbManager } from "@/lib/database-manager"
import { quotaManager } from "@/lib/resource-quotas"
import { z } from "zod"

const pitrRestoreSchema = z.object({
  timestamp: z.string().datetime("Invalid timestamp format"),
  targetDatabase: z.string().optional(),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Check if user has PITR feature enabled
    const quota = await quotaManager.getUserQuota(auth.user.id)
    if (!quota.features.enablePITR) {
      return NextResponse.json({
        code: "FEATURE_NOT_AVAILABLE",
        message: "Point-in-Time Recovery is not available in your current plan"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const pitrRange = await dbManager.getPITRRange()

    return NextResponse.json({
      pitrRange: {
        earliest: pitrRange.earliest.toISOString(),
        latest: pitrRange.latest.toISOString(),
      },
      message: "Point-in-Time Recovery is available for the specified time range",
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching PITR range:", error)
    return createInternalError("Failed to fetch PITR information")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can perform PITR
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Point-in-Time Recovery requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Check if user has PITR feature enabled
    const quota = await quotaManager.getUserQuota(auth.user.id)
    if (!quota.features.enablePITR) {
      return NextResponse.json({
        code: "FEATURE_NOT_AVAILABLE",
        message: "Point-in-Time Recovery is not available in your current plan"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const validation = await validateRequestBody(request, pitrRestoreSchema)
    if (!validation.success) {
      return validation.error
    }

    const { timestamp, targetDatabase } = validation.data

    // Validate timestamp is within PITR range
    const pitrRange = await dbManager.getPITRRange()
    const restoreTime = new Date(timestamp)
    
    if (restoreTime < pitrRange.earliest || restoreTime > pitrRange.latest) {
      return NextResponse.json({
        code: "TIMESTAMP_OUT_OF_RANGE",
        message: `Timestamp must be between ${pitrRange.earliest.toISOString()} and ${pitrRange.latest.toISOString()}`
      }, { 
        status: 400,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Perform PITR restore
    const restoreId = await dbManager.restoreToPointInTime(restoreTime, targetDatabase)

    return NextResponse.json({
      success: true,
      restoreId,
      message: "Point-in-Time Recovery initiated",
      restoreTime: restoreTime.toISOString(),
    }, {
      status: 202, // Accepted - restore is being processed
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error performing PITR:", error)
    return createInternalError("Failed to perform Point-in-Time Recovery")
  }
}