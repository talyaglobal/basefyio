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

const createScheduleSchema = z.object({
  name: z.string().min(1, "Schedule name is required").max(50),
  frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format").optional(),
  dayOfWeek: z.number().min(0).max(6).optional(), // 0 = Sunday
  dayOfMonth: z.number().min(1).max(31).optional(),
  enabled: z.boolean().default(true),
  retentionDays: z.number().min(1).max(365).default(30),
})

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dayOfWeek: z.number().min(0).max(6).optional(),
  dayOfMonth: z.number().min(1).max(31).optional(),
  enabled: z.boolean().optional(),
  retentionDays: z.number().min(1).max(365).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["backup"])
    if (!auth.success) {
      return auth.error
    }

    // No quota check needed for listing schedules

    const schedules = backupScheduler.getSchedules()
    const runningJobs = backupScheduler.getRunningJobs()

    return NextResponse.json({
      schedules: schedules.map(schedule => ({
        ...schedule,
        lastRun: schedule.lastRun?.toISOString(),
        nextRun: schedule.nextRun.toISOString(),
        createdAt: schedule.createdAt.toISOString(),
      })),
      runningJobs: runningJobs.map(job => ({
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
    console.error("Error fetching backup schedules:", error)
    return createInternalError("Failed to fetch backup schedules")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["backup"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can create schedules
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Creating backup schedules requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Check backup quota
    const quotaCheck = await quotaManager.checkQuotaViolation(
      auth.user.id, 
      'backup', 
      'create'
    )

    if (!quotaCheck.allowed) {
      return NextResponse.json({
        code: "QUOTA_EXCEEDED",
        message: quotaCheck.message
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const validation = await validateRequestBody(request, createScheduleSchema)
    if (!validation.success) {
      return validation.error
    }

    const scheduleData = validation.data

    // Validate time and day constraints
    if (scheduleData.frequency === 'weekly' && scheduleData.dayOfWeek === undefined) {
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

    if (scheduleData.frequency === 'monthly' && scheduleData.dayOfMonth === undefined) {
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

    // Check existing schedules limit
    const existingSchedules = backupScheduler.getSchedules()
    const quota = await quotaManager.getUserQuota(auth.user.id)
    
    if (existingSchedules.length >= quota.backup.maxBackups) {
      return NextResponse.json({
        code: "SCHEDULE_LIMIT_EXCEEDED",
        message: `Maximum number of backup schedules reached (${quota.backup.maxBackups})`
      }, { 
        status: 409,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Create schedule - ensure enabled has a default value
    const scheduleId = await backupScheduler.createSchedule({
      name: scheduleData.name,
      frequency: scheduleData.frequency,
      time: scheduleData.time,
      dayOfWeek: scheduleData.dayOfWeek,
      dayOfMonth: scheduleData.dayOfMonth,
      retentionDays: scheduleData.retentionDays ?? 30,
      enabled: scheduleData.enabled ?? true,
      userId: auth.user.id,
    })

    return NextResponse.json({
      success: true,
      scheduleId,
      message: "Backup schedule created successfully",
    }, {
      status: 201,
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error creating backup schedule:", error)
    return createInternalError("Failed to create backup schedule")
  }
}