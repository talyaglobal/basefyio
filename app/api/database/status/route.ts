import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { dbManager } from "@/lib/database-manager"
import { connectionPool } from "@/lib/connection-pool"
import { quotaManager } from "@/lib/resource-quotas"
import { backupScheduler } from "@/lib/backup-scheduler"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, [])
    if (!auth.success) {
      return auth.error
    }

    // Get overall database status and health
    const healthChecks = await Promise.allSettled([
      // Database connectivity
      connectionPool.execute(async (sql) => {
        await sql`SELECT 1`
        return { status: 'connected', timestamp: new Date().toISOString() }
      }),

      // Basic database info
      connectionPool.execute(async (sql) => {
        const result = await sql`SELECT version()`
        return { version: result[0]?.version || 'Unknown' }
      }),

      // Database size (approximate)
      ((dbManager as any).getStorageUsage?.() || Promise.resolve({ used: 0, total: 0, percent: 0 })),

      // Get user's quota and current usage
      Promise.all([
        quotaManager.getUserQuota(auth.user.id),
        quotaManager.getCurrentUsage(auth.user.id),
      ]),

      // Get recent backup status
      backupScheduler.getRunningJobs(),
    ])

    const [
      connectivity,
      dbInfo,
      storage,
      quotaInfo,
      runningBackups,
    ] = healthChecks.map(result => 
      result.status === 'fulfilled' ? result.value : null
    )

    // Parse quota information
    const [quota, usage] = quotaInfo || [null, null]

    // Get connection pool health
    const poolStats = connectionPool.getStats()
    const poolHealth = {
      status: poolStats.active < poolStats.total * 0.9 ? 'healthy' : 'warning',
      utilization: (poolStats.active / poolStats.total) * 100,
      activeConnections: poolStats.active,
      totalConnections: poolStats.total,
    }

    // Determine overall status
    const overallStatus = determineOverallStatus({
      connectivity: !!connectivity,
      poolHealth: poolHealth.status === 'healthy',
      storageHealthy: storage ? storage.percent < 90 : true,
      quotaHealthy: quota && usage ? usage.database.size < quota.database.maxSize * 0.9 : true,
    })

    const statusResponse = {
      timestamp: new Date().toISOString(),
      status: overallStatus,
      database: {
        connected: !!connectivity,
        version: dbInfo?.version?.split(' ')[0] || 'Unknown',
        provider: process.env.DB_PROVIDER || 'neon',
        region: process.env.DB_REGION || 'unknown',
      },
      storage: storage || { used: 0, total: 0, percent: 0 },
      connectionPool: poolHealth,
      quotas: quota ? {
        plan: quota.plan || 'free',
        database: {
          used: usage?.database?.size || 0,
          limit: quota.database.maxSize,
          utilization: usage?.database?.size ? (usage.database.size / quota.database.maxSize) * 100 : 0,
        },
        api: {
          used: usage?.api?.requestsToday || 0,
          limit: quota.api.maxRequestsPerDay,
          utilization: usage?.api?.requestsToday ? (usage.api.requestsToday / quota.api.maxRequestsPerDay) * 100 : 0,
        },
        backup: {
          used: usage?.backup?.count || 0,
          limit: quota.backup.maxBackups,
        },
      } : null,
      backups: {
        scheduled: backupScheduler.getSchedules().length,
        running: runningBackups?.length || 0,
        lastCompleted: getLastCompletedBackup(),
      },
      features: quota ? {
        replicas: quota.features.enableReplicas,
        pitr: quota.features.enablePITR,
        webhooks: quota.features.enableWebhooks,
        migrations: quota.features.enableMigrations,
      } : null,
    }

    return NextResponse.json(statusResponse, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      }
    })
  } catch (error: any) {
    console.error("Error fetching database status:", error)
    return createInternalError("Failed to fetch database status")
  }
}

function determineOverallStatus(checks: {
  connectivity: boolean
  poolHealth: boolean
  storageHealthy: boolean
  quotaHealthy: boolean
}): 'healthy' | 'warning' | 'critical' {
  if (!checks.connectivity) {
    return 'critical'
  }

  if (!checks.poolHealth || !checks.storageHealthy) {
    return 'warning'
  }

  if (!checks.quotaHealthy) {
    return 'warning'
  }

  return 'healthy'
}

function getLastCompletedBackup(): string | null {
  try {
    const schedules = backupScheduler.getSchedules()
    let lastCompleted: Date | null = null

    for (const schedule of schedules) {
      if (schedule.lastRun && (!lastCompleted || schedule.lastRun > lastCompleted)) {
        lastCompleted = schedule.lastRun
      }
    }

    return lastCompleted ? lastCompleted.toISOString() : null
  } catch {
    return null
  }
}