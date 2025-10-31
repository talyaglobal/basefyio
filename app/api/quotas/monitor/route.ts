import { type NextRequest, NextResponse } from "next/server"
import { 
  requireScopesWithRateLimit, 
  createInternalError, 
  securityHeaders 
} from "@/lib/api-utils"
import { quotaManager } from "@/lib/resource-quotas"

type Severity = 'low' | 'medium' | 'high' | 'critical'

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["read:quotas"])
    if (!auth.success) {
      return auth.error
    }

    const userId = auth.user.id

    const [quota, usage] = await Promise.all([
      quotaManager.getUserQuota(userId),
      quotaManager.getCurrentUsage(userId),
    ])

    const violations: Array<{
      id: string
      resource: 'database' | 'storage' | 'api' | 'backup'
      severity: Severity
      message: string
      utilizationPercent: number
      timestamp: string
      acknowledged: boolean
    }> = []

    // Database
    const dbUsagePct = Math.min(100, (usage.database.size / quota.database.maxSize) * 100)
    if (dbUsagePct >= 90) {
      violations.push({
        id: `db-size-${Date.now()}`,
        resource: 'database',
        severity: dbUsagePct >= 100 ? 'critical' : dbUsagePct >= 95 ? 'high' : 'medium',
        message: `Database size at ${dbUsagePct.toFixed(1)}% of quota`,
        utilizationPercent: dbUsagePct,
        timestamp: new Date().toISOString(),
        acknowledged: false,
      })
    }
    if (usage.database.tables >= quota.database.maxTables) {
      violations.push({
        id: `db-tables-${Date.now()}`,
        resource: 'database',
        severity: 'high',
        message: `Maximum number of tables reached (${quota.database.maxTables})`,
        utilizationPercent: 100,
        timestamp: new Date().toISOString(),
        acknowledged: false,
      })
    }

    // Storage
    const storagePct = Math.min(100, (usage.storage.size / quota.storage.maxSize) * 100)
    if (storagePct >= 90) {
      violations.push({
        id: `storage-size-${Date.now()}`,
        resource: 'storage',
        severity: storagePct >= 100 ? 'critical' : storagePct >= 95 ? 'high' : 'medium',
        message: `Storage usage at ${storagePct.toFixed(1)}% of quota`,
        utilizationPercent: storagePct,
        timestamp: new Date().toISOString(),
        acknowledged: false,
      })
    }

    // API
    const hourPct = Math.min(100, (usage.api.requestsLastHour / quota.api.maxRequestsPerHour) * 100)
    if (hourPct >= 90) {
      violations.push({
        id: `api-hour-${Date.now()}`,
        resource: 'api',
        severity: hourPct >= 100 ? 'high' : 'medium',
        message: `Hourly API usage at ${hourPct.toFixed(1)}% of quota`,
        utilizationPercent: hourPct,
        timestamp: new Date().toISOString(),
        acknowledged: false,
      })
    }
    const dayPct = Math.min(100, (usage.api.requestsToday / quota.api.maxRequestsPerDay) * 100)
    if (dayPct >= 90) {
      violations.push({
        id: `api-day-${Date.now()}`,
        resource: 'api',
        severity: dayPct >= 100 ? 'high' : 'medium',
        message: `Daily API usage at ${dayPct.toFixed(1)}% of quota`,
        utilizationPercent: dayPct,
        timestamp: new Date().toISOString(),
        acknowledged: false,
      })
    }

    // Backup
    const backupCountPct = Math.min(100, (usage.backup.count / quota.backup.maxBackups) * 100)
    if (backupCountPct >= 100) {
      violations.push({
        id: `backup-count-${Date.now()}`,
        resource: 'backup',
        severity: 'high',
        message: `Maximum number of backups reached (${quota.backup.maxBackups})`,
        utilizationPercent: backupCountPct,
        timestamp: new Date().toISOString(),
        acknowledged: false,
      })
    }

    const backupSizePct = Math.min(100, (usage.backup.totalSize / quota.backup.maxBackupSize) * 100)
    if (backupSizePct >= 90) {
      violations.push({
        id: `backup-size-${Date.now()}`,
        resource: 'backup',
        severity: backupSizePct >= 100 ? 'critical' : backupSizePct >= 95 ? 'high' : 'medium',
        message: `Backup storage at ${backupSizePct.toFixed(1)}% of quota`,
        utilizationPercent: backupSizePct,
        timestamp: new Date().toISOString(),
        acknowledged: false,
      })
    }

    const summary = violations.reduce(
      (acc, v) => {
        acc[v.severity] += 1
        return acc
      },
      { low: 0, medium: 0, high: 0, critical: 0 } as Record<Severity, number>
    )

    return NextResponse.json({
      violationsDetected: violations.length,
      violations,
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

export async function POST(request: NextRequest) {
  try {
    const auth = await requireScopesWithRateLimit(request, ["admin"])
    if (!auth.success) {
      return auth.error
    }

    // Manual trigger for quota monitoring (admin only)
    // Note: This requires the quota-monitor to be implemented
    // For now, return empty violations
    const violations: any[] = []

    return NextResponse.json({
      success: true,
      violationsDetected: violations.length,
      violations: violations.map(v => ({
        userId: v.userId,
        resource: v.resource,
        severity: v.severity,
        message: v.message,
        utilizationPercent: v.utilizationPercent
      }))
    }, {
      headers: {
        ...securityHeaders(),
        ...auth.rateLimitHeaders,
      }
    })
  } catch (error: any) {
    console.error("Error running quota monitoring:", error)
    return createInternalError("Failed to run quota monitoring")
  }
}