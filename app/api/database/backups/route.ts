import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  validateSearchParams,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { paginationSchema } from "@/lib/validation-schemas"
import { dbManager } from "@/lib/database-manager"
import { quotaManager } from "@/lib/resource-quotas"
import { z } from "zod"

const createBackupSchema = z.object({
  name: z.string().min(1, "Backup name is required").max(100),
  type: z.enum(["manual", "scheduled"]).default("manual"),
})

const backupQuerySchema = paginationSchema.extend({
  type: z.enum(["manual", "scheduled", "pitr"]).optional(),
  status: z.enum(["creating", "completed", "failed", "deleted"]).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const validation = validateSearchParams(searchParams, backupQuerySchema)
    if (!validation.success) {
      return validation.error
    }

    const { limit, cursor, type, status } = validation.data

    const allBackups = await dbManager.listBackups()
    
    // Filter backups based on query parameters
    let filteredBackups = allBackups
    if (type) {
      filteredBackups = filteredBackups.filter(backup => backup.type === type)
    }
    if (status) {
      filteredBackups = filteredBackups.filter(backup => backup.status === status)
    }

    // Simple pagination implementation (in production, would use proper cursor-based pagination)
    const startIndex = cursor ? parseInt(atob(cursor)) : 0
    const endIndex = startIndex + (limit || 50)
    const paginatedBackups = filteredBackups.slice(startIndex, endIndex)
    const hasMore = endIndex < filteredBackups.length
    const nextCursor = hasMore ? btoa((endIndex).toString()) : null

    return NextResponse.json({
      backups: paginatedBackups,
      nextCursor,
      hasMore,
      total: filteredBackups.length,
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching backups:", error)
    return createInternalError("Failed to fetch backups")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can create backups
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Backup creation requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const validation = await validateRequestBody(request, createBackupSchema)
    if (!validation.success) {
      return validation.error
    }

    const { name, type } = validation.data

    // Check backup quota
    const quotaCheck = await quotaManager.checkQuotaViolation(auth.user.id, 'backup', 'create')
    if (!quotaCheck.allowed) {
      return NextResponse.json({
        code: "QUOTA_EXCEEDED",
        message: quotaCheck.message
      }, { 
        status: 409,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Create backup
    const backupId = await dbManager.createBackup(`${name}_${auth.user.id}`, type)

    return NextResponse.json({
      success: true,
      backupId,
      message: "Backup creation initiated",
    }, {
      status: 202, // Accepted - backup is being created
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error creating backup:", error)
    return createInternalError("Failed to create backup")
  }
}