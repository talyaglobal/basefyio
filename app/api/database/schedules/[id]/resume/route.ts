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

    // Only session users can resume schedules
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Resuming backup schedules requires session authentication"
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

    // Users can only resume their own schedules (unless admin)
    if (schedule.userId !== auth.user.id && 
        (auth.user.authMethod !== "session" || auth.user.email !== "admin@kolaybase.com")) {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "You can only resume your own backup schedules"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    if (schedule.enabled) {
      return NextResponse.json({
        code: "SCHEDULE_ALREADY_ACTIVE",
        message: "Backup schedule is already active"
      }, { 
        status: 409,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Resume schedule
    await backupScheduler.resumeSchedule(id)

    return NextResponse.json({
      success: true,
      message: "Backup schedule resumed successfully",
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error resuming backup schedule:", error)
    return createInternalError("Failed to resume backup schedule")
  }
}