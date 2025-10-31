import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { backupScheduler } from "@/lib/backup-scheduler"
import { quotaManager } from "@/lib/resource-quotas"
import { z } from "zod"

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dayOfWeek: z.number().min(0).max(6).optional(),
  dayOfMonth: z.number().min(1).max(31).optional(),
  enabled: z.boolean().optional(),
  retentionDays: z.number().min(1).max(365).optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["backup"])
    if (!auth.success) {
      return auth.error
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

    // Users can only view their own schedules (unless admin)
    if (schedule.userId !== auth.user.id && 
        (auth.user.authMethod !== "session" || auth.user.email !== "admin@kolaybase.com")) {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "You can only view your own backup schedules"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Get job history for this schedule
    const jobHistory = await backupScheduler.getJobHistory(id, 10)

    return NextResponse.json({
      schedule: {
        ...schedule,
        lastRun: schedule.lastRun?.toISOString(),
        nextRun: schedule.nextRun.toISOString(),
        createdAt: schedule.createdAt.toISOString(),
      },
      jobHistory: jobHistory.map(job => ({
        ...job,
        startedAt: job.startedAt.toISOString(),
        completedAt: job.completedAt?.toISOString(),
      })),
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching backup schedule:", error)
    return createInternalError("Failed to fetch backup schedule")
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["backup"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can update schedules
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Updating backup schedules requires session authentication"
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

    // Users can only update their own schedules (unless admin)
    if (schedule.userId !== auth.user.id && 
        (auth.user.authMethod !== "session" || auth.user.email !== "admin@kolaybase.com")) {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "You can only update your own backup schedules"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const validation = await validateRequestBody(request, updateScheduleSchema)
    if (!validation.success) {
      return validation.error
    }

    const updates = validation.data

    // Validate constraints if frequency is being changed
    if (updates.frequency === 'weekly' && !updates.dayOfWeek && !schedule.dayOfWeek) {
      return NextResponse.json({
        code: "VALIDATION_ERROR",
        message: "dayOfWeek is required for weekly schedules"
      }, { 
        status: 400,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    if (updates.frequency === 'monthly' && !updates.dayOfMonth && !schedule.dayOfMonth) {
      return NextResponse.json({
        code: "VALIDATION_ERROR",
        message: "dayOfMonth is required for monthly schedules"
      }, { 
        status: 400,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Update schedule
    await backupScheduler.updateScheduleConfig(id, updates)

    // Get updated schedule
    const updatedSchedule = backupScheduler.getSchedule(id)

    return NextResponse.json({
      success: true,
      schedule: updatedSchedule ? {
        ...updatedSchedule,
        lastRun: updatedSchedule.lastRun?.toISOString(),
        nextRun: updatedSchedule.nextRun.toISOString(),
        createdAt: updatedSchedule.createdAt.toISOString(),
      } : null,
      message: "Backup schedule updated successfully",
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error updating backup schedule:", error)
    return createInternalError("Failed to update backup schedule")
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["backup"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can delete schedules
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Deleting backup schedules requires session authentication"
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

    // Users can only delete their own schedules (unless admin)
    if (schedule.userId !== auth.user.id && 
        (auth.user.authMethod !== "session" || auth.user.email !== "admin@kolaybase.com")) {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "You can only delete your own backup schedules"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Delete schedule
    await backupScheduler.deleteSchedule(id)

    return NextResponse.json({
      success: true,
      message: "Backup schedule deleted successfully",
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error deleting backup schedule:", error)
    return createInternalError("Failed to delete backup schedule")
  }
}