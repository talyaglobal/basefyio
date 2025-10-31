import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { backupScheduler } from "@/lib/backup-scheduler"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["backup"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can pause schedules
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Pausing backup schedules requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const { id } = await params
    
    const schedule = backupScheduler.getSchedule(id)
    if (!schedule) {
      return NextResponse.json({
        code: "SCHEDULE_NOT_FOUND",
        message: "Backup schedule not found"
      }, { 
        status: 404,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Users can only pause their own schedules (unless admin)
    if (schedule.userId !== auth.user.id && 
        (auth.user.authMethod !== "session" || auth.user.email !== "admin@kolaybase.com")) {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "You can only pause your own backup schedules"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    if (!schedule.enabled) {
      return NextResponse.json({
        code: "SCHEDULE_ALREADY_PAUSED",
        message: "Backup schedule is already paused"
      }, { 
        status: 409,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Pause schedule
    await backupScheduler.pauseSchedule(id)

    return NextResponse.json({
      success: true,
      message: "Backup schedule paused successfully",
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error pausing backup schedule:", error)
    return createInternalError("Failed to pause backup schedule")
  }
}