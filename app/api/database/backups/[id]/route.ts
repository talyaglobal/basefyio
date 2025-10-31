import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  validateRequestBody,
  createNotFoundError,
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { dbManager } from "@/lib/database-manager"
import { z } from "zod"

const restoreBackupSchema = z.object({
  targetDatabase: z.string().optional(),
  overwrite: z.boolean().default(false),
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    const { id } = await params
    const backups = await dbManager.listBackups()
    const backup = backups.find(b => b.id === id)

    if (!backup) {
      return createNotFoundError("Backup")
    }

    return NextResponse.json({ backup }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error fetching backup:", error)
    return createInternalError("Failed to fetch backup")
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can restore backups
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Backup restoration requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const { id } = await params
    const validation = await validateRequestBody(request, restoreBackupSchema)
    if (!validation.success) {
      return validation.error
    }

    const { targetDatabase, overwrite } = validation.data

    // Check if backup exists
    const backups = await dbManager.listBackups()
    const backup = backups.find(b => b.id === id)

    if (!backup) {
      return createNotFoundError("Backup")
    }

    if (backup.status !== 'completed') {
      return NextResponse.json({
        code: "BACKUP_NOT_READY",
        message: `Backup is not ready for restoration (status: ${backup.status})`
      }, { 
        status: 400,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    // Restore backup
    await dbManager.restoreBackup(id, targetDatabase)

    return NextResponse.json({
      success: true,
      message: "Backup restoration completed successfully",
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error restoring backup:", error)
    return createInternalError("Failed to restore backup")
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Only session users can delete backups
    if (auth.user.authMethod !== "session") {
      return NextResponse.json({
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Backup deletion requires session authentication"
      }, { 
        status: 403,
        headers: {
          ...securityHeaders(),
          ...auth.rateLimitHeaders,
        }
      })
    }

    const { id } = await params

    // Check if backup exists
    const backups = await dbManager.listBackups()
    const backup = backups.find(b => b.id === id)

    if (!backup) {
      return createNotFoundError("Backup")
    }

    // Delete backup
    await dbManager.deleteBackup(id)

    return NextResponse.json({
      success: true,
      message: "Backup deleted successfully",
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error deleting backup:", error)
    return createInternalError("Failed to delete backup")
  }
}