import { safeDb } from './db-safety'
import { quotaManager, type ResourceQuota, type ResourceUsage } from './resource-quotas'
import { jobScheduler } from './scheduler'

export interface QuotaViolation {
  id: string
  userId: string
  resource: keyof ResourceUsage
  violationType: 'threshold' | 'limit_exceeded' | 'near_limit'
  currentUsage: number
  quotaLimit: number
  utilizationPercent: number
  timestamp: Date
  severity: 'low' | 'medium' | 'high' | 'critical'
  message: string
  acknowledged: boolean
  acknowledgedAt?: Date
  acknowledgedBy?: string
}

export interface QuotaThreshold {
  resource: keyof ResourceUsage
  metric: string
  warningThreshold: number // percentage (e.g., 80 = 80%)
  criticalThreshold: number // percentage (e.g., 95 = 95%)
  enabled: boolean
}

export interface AlertChannel {
  id: string
  userId: string
  type: 'webhook' | 'email' | 'slack'
  config: {
    url?: string
    email?: string
    slackChannel?: string
    headers?: Record<string, string>
  }
  enabled: boolean
  events: string[] // ['quota_warning', 'quota_critical', 'quota_exceeded']
}

export const DEFAULT_THRESHOLDS: QuotaThreshold[] = [
  {
    resource: 'database',
    metric: 'size',
    warningThreshold: 80,
    criticalThreshold: 95,
    enabled: true
  },
  {
    resource: 'database',
    metric: 'tables',
    warningThreshold: 80,
    criticalThreshold: 90,
    enabled: true
  },
  {
    resource: 'database',
    metric: 'connections',
    warningThreshold: 70,
    criticalThreshold: 90,
    enabled: true
  },
  {
    resource: 'storage',
    metric: 'size',
    warningThreshold: 80,
    criticalThreshold: 95,
    enabled: true
  },
  {
    resource: 'storage',
    metric: 'files',
    warningThreshold: 80,
    criticalThreshold: 90,
    enabled: true
  },
  {
    resource: 'api',
    metric: 'requestsLastHour',
    warningThreshold: 85,
    criticalThreshold: 95,
    enabled: true
  },
  {
    resource: 'api',
    metric: 'requestsToday',
    warningThreshold: 85,
    criticalThreshold: 95,
    enabled: true
  },
  {
    resource: 'api',
    metric: 'concurrentRequests',
    warningThreshold: 80,
    criticalThreshold: 90,
    enabled: true
  },
  {
    resource: 'backup',
    metric: 'count',
    warningThreshold: 80,
    criticalThreshold: 90,
    enabled: true
  },
  {
    resource: 'backup',
    metric: 'totalSize',
    warningThreshold: 80,
    criticalThreshold: 95,
    enabled: true
  }
]

export class QuotaMonitor {
  private static instance: QuotaMonitor
  private monitoringJobId?: string

  constructor() {
    this.initializeMonitoring()
  }

  static getInstance(): QuotaMonitor {
    if (!QuotaMonitor.instance) {
      QuotaMonitor.instance = new QuotaMonitor()
    }
    return QuotaMonitor.instance
  }

  private async initializeMonitoring() {
    try {
      // Create monitoring job that runs every 5 minutes
      this.monitoringJobId = await jobScheduler.createJob({
        name: 'Quota Monitoring',
        description: 'Monitor resource quotas and trigger alerts for violations',
        cron_expression: '*/5 * * * *', // Every 5 minutes
        webhook_url: 'internal://quota-monitor',
        payload: {},
        timezone: 'UTC',
        is_active: true,
        created_by: 'system'
      })

      console.log('📊 Quota monitoring initialized')
    } catch (error) {
      console.error('Failed to initialize quota monitoring:', error)
    }
  }

  async checkAllUserQuotas(): Promise<QuotaViolation[]> {
    const violations: QuotaViolation[] = []

    try {
      // Get all active users
      const usersResult = await safeDb.safeSelect(`
        SELECT DISTINCT id FROM users WHERE is_active = TRUE
      `)

      for (const user of usersResult.rows) {
        const userViolations = await this.checkUserQuotas(user.id)
        violations.push(...userViolations)
      }

      // Store violations in database
      if (violations.length > 0) {
        await this.storeViolations(violations)
        await this.processAlerts(violations)
      }

      console.log(`🔍 Quota check completed: ${violations.length} violations found`)
    } catch (error) {
      console.error('Error during quota monitoring:', error)
    }

    return violations
  }

  async checkUserQuotas(userId: string): Promise<QuotaViolation[]> {
    const violations: QuotaViolation[] = []

    try {
      const [quota, usage, thresholds] = await Promise.all([
        quotaManager.getUserQuota(userId),
        quotaManager.getCurrentUsage(userId),
        this.getUserThresholds(userId)
      ])

      // Check each resource against thresholds
      violations.push(...this.checkDatabaseQuotas(userId, quota, usage, thresholds))
      violations.push(...this.checkStorageQuotas(userId, quota, usage, thresholds))
      violations.push(...this.checkApiQuotas(userId, quota, usage, thresholds))
      violations.push(...this.checkBackupQuotas(userId, quota, usage, thresholds))

    } catch (error) {
      console.error(`Error checking quotas for user ${userId}:`, error)
    }

    return violations
  }

  private checkDatabaseQuotas(
    userId: string,
    quota: ResourceQuota,
    usage: ResourceUsage,
    thresholds: QuotaThreshold[]
  ): QuotaViolation[] {
    const violations: QuotaViolation[] = []

    // Database size check
    const sizeThreshold = thresholds.find(t => t.resource === 'database' && t.metric === 'size' && t.enabled)
    if (sizeThreshold) {
      const utilizationPercent = (usage.database.size / quota.database.maxSize) * 100
      
      if (utilizationPercent >= sizeThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'database',
          'threshold',
          usage.database.size,
          quota.database.maxSize,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Database size at ${utilizationPercent.toFixed(1)}% of quota (${this.formatBytes(usage.database.size)}/${this.formatBytes(quota.database.maxSize)})`
        ))
      } else if (utilizationPercent >= sizeThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'database',
          'near_limit',
          usage.database.size,
          quota.database.maxSize,
          utilizationPercent,
          'medium',
          `Database size approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    // Table count check
    const tablesThreshold = thresholds.find(t => t.resource === 'database' && t.metric === 'tables' && t.enabled)
    if (tablesThreshold) {
      const utilizationPercent = (usage.database.tables / quota.database.maxTables) * 100
      
      if (utilizationPercent >= tablesThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'database',
          'threshold',
          usage.database.tables,
          quota.database.maxTables,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Table count at ${utilizationPercent.toFixed(1)}% of quota (${usage.database.tables}/${quota.database.maxTables})`
        ))
      } else if (utilizationPercent >= tablesThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'database',
          'near_limit',
          usage.database.tables,
          quota.database.maxTables,
          utilizationPercent,
          'medium',
          `Table count approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    // Connection count check
    const connectionsThreshold = thresholds.find(t => t.resource === 'database' && t.metric === 'connections' && t.enabled)
    if (connectionsThreshold) {
      const utilizationPercent = (usage.database.connections / quota.database.maxConnections) * 100
      
      if (utilizationPercent >= connectionsThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'database',
          'threshold',
          usage.database.connections,
          quota.database.maxConnections,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Active connections at ${utilizationPercent.toFixed(1)}% of quota (${usage.database.connections}/${quota.database.maxConnections})`
        ))
      } else if (utilizationPercent >= connectionsThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'database',
          'near_limit',
          usage.database.connections,
          quota.database.maxConnections,
          utilizationPercent,
          'medium',
          `Active connections approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    return violations
  }

  private checkStorageQuotas(
    userId: string,
    quota: ResourceQuota,
    usage: ResourceUsage,
    thresholds: QuotaThreshold[]
  ): QuotaViolation[] {
    const violations: QuotaViolation[] = []

    // Storage size check
    const sizeThreshold = thresholds.find(t => t.resource === 'storage' && t.metric === 'size' && t.enabled)
    if (sizeThreshold) {
      const utilizationPercent = (usage.storage.size / quota.storage.maxSize) * 100
      
      if (utilizationPercent >= sizeThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'storage',
          'threshold',
          usage.storage.size,
          quota.storage.maxSize,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Storage size at ${utilizationPercent.toFixed(1)}% of quota (${this.formatBytes(usage.storage.size)}/${this.formatBytes(quota.storage.maxSize)})`
        ))
      } else if (utilizationPercent >= sizeThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'storage',
          'near_limit',
          usage.storage.size,
          quota.storage.maxSize,
          utilizationPercent,
          'medium',
          `Storage size approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    // File count check
    const filesThreshold = thresholds.find(t => t.resource === 'storage' && t.metric === 'files' && t.enabled)
    if (filesThreshold) {
      const utilizationPercent = (usage.storage.files / quota.storage.maxFiles) * 100
      
      if (utilizationPercent >= filesThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'storage',
          'threshold',
          usage.storage.files,
          quota.storage.maxFiles,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `File count at ${utilizationPercent.toFixed(1)}% of quota (${usage.storage.files}/${quota.storage.maxFiles})`
        ))
      } else if (utilizationPercent >= filesThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'storage',
          'near_limit',
          usage.storage.files,
          quota.storage.maxFiles,
          utilizationPercent,
          'medium',
          `File count approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    return violations
  }

  private checkApiQuotas(
    userId: string,
    quota: ResourceQuota,
    usage: ResourceUsage,
    thresholds: QuotaThreshold[]
  ): QuotaViolation[] {
    const violations: QuotaViolation[] = []

    // Hourly requests check
    const hourlyThreshold = thresholds.find(t => t.resource === 'api' && t.metric === 'requestsLastHour' && t.enabled)
    if (hourlyThreshold) {
      const utilizationPercent = (usage.api.requestsLastHour / quota.api.maxRequestsPerHour) * 100
      
      if (utilizationPercent >= hourlyThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'api',
          'threshold',
          usage.api.requestsLastHour,
          quota.api.maxRequestsPerHour,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Hourly API requests at ${utilizationPercent.toFixed(1)}% of quota (${usage.api.requestsLastHour}/${quota.api.maxRequestsPerHour})`
        ))
      } else if (utilizationPercent >= hourlyThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'api',
          'near_limit',
          usage.api.requestsLastHour,
          quota.api.maxRequestsPerHour,
          utilizationPercent,
          'medium',
          `Hourly API requests approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    // Daily requests check
    const dailyThreshold = thresholds.find(t => t.resource === 'api' && t.metric === 'requestsToday' && t.enabled)
    if (dailyThreshold) {
      const utilizationPercent = (usage.api.requestsToday / quota.api.maxRequestsPerDay) * 100
      
      if (utilizationPercent >= dailyThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'api',
          'threshold',
          usage.api.requestsToday,
          quota.api.maxRequestsPerDay,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Daily API requests at ${utilizationPercent.toFixed(1)}% of quota (${usage.api.requestsToday}/${quota.api.maxRequestsPerDay})`
        ))
      } else if (utilizationPercent >= dailyThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'api',
          'near_limit',
          usage.api.requestsToday,
          quota.api.maxRequestsPerDay,
          utilizationPercent,
          'medium',
          `Daily API requests approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    // Concurrent requests check
    const concurrentThreshold = thresholds.find(t => t.resource === 'api' && t.metric === 'concurrentRequests' && t.enabled)
    if (concurrentThreshold) {
      const utilizationPercent = (usage.api.concurrentRequests / quota.api.maxConcurrentRequests) * 100
      
      if (utilizationPercent >= concurrentThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'api',
          'threshold',
          usage.api.concurrentRequests,
          quota.api.maxConcurrentRequests,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Concurrent API requests at ${utilizationPercent.toFixed(1)}% of quota (${usage.api.concurrentRequests}/${quota.api.maxConcurrentRequests})`
        ))
      } else if (utilizationPercent >= concurrentThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'api',
          'near_limit',
          usage.api.concurrentRequests,
          quota.api.maxConcurrentRequests,
          utilizationPercent,
          'medium',
          `Concurrent API requests approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    return violations
  }

  private checkBackupQuotas(
    userId: string,
    quota: ResourceQuota,
    usage: ResourceUsage,
    thresholds: QuotaThreshold[]
  ): QuotaViolation[] {
    const violations: QuotaViolation[] = []

    // Backup count check
    const countThreshold = thresholds.find(t => t.resource === 'backup' && t.metric === 'count' && t.enabled)
    if (countThreshold) {
      const utilizationPercent = (usage.backup.count / quota.backup.maxBackups) * 100
      
      if (utilizationPercent >= countThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'backup',
          'threshold',
          usage.backup.count,
          quota.backup.maxBackups,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Backup count at ${utilizationPercent.toFixed(1)}% of quota (${usage.backup.count}/${quota.backup.maxBackups})`
        ))
      } else if (utilizationPercent >= countThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'backup',
          'near_limit',
          usage.backup.count,
          quota.backup.maxBackups,
          utilizationPercent,
          'medium',
          `Backup count approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    // Backup size check
    const sizeThreshold = thresholds.find(t => t.resource === 'backup' && t.metric === 'totalSize' && t.enabled)
    if (sizeThreshold) {
      const utilizationPercent = (usage.backup.totalSize / quota.backup.maxBackupSize) * 100
      
      if (utilizationPercent >= sizeThreshold.criticalThreshold) {
        violations.push(this.createViolation(
          userId,
          'backup',
          'threshold',
          usage.backup.totalSize,
          quota.backup.maxBackupSize,
          utilizationPercent,
          utilizationPercent >= 100 ? 'critical' : 'high',
          `Backup storage at ${utilizationPercent.toFixed(1)}% of quota (${this.formatBytes(usage.backup.totalSize)}/${this.formatBytes(quota.backup.maxBackupSize)})`
        ))
      } else if (utilizationPercent >= sizeThreshold.warningThreshold) {
        violations.push(this.createViolation(
          userId,
          'backup',
          'near_limit',
          usage.backup.totalSize,
          quota.backup.maxBackupSize,
          utilizationPercent,
          'medium',
          `Backup storage approaching limit at ${utilizationPercent.toFixed(1)}% of quota`
        ))
      }
    }

    return violations
  }

  private createViolation(
    userId: string,
    resource: keyof ResourceUsage,
    violationType: 'threshold' | 'limit_exceeded' | 'near_limit',
    currentUsage: number,
    quotaLimit: number,
    utilizationPercent: number,
    severity: 'low' | 'medium' | 'high' | 'critical',
    message: string
  ): QuotaViolation {
    return {
      id: `violation_${Date.now()}_${Math.random().toString(36).substring(2)}`,
      userId,
      resource,
      violationType,
      currentUsage,
      quotaLimit,
      utilizationPercent,
      timestamp: new Date(),
      severity,
      message,
      acknowledged: false
    }
  }

  private async getUserThresholds(userId: string): Promise<QuotaThreshold[]> {
    try {
      const result = await safeDb.safeSelect(`
        SELECT * FROM quota_thresholds WHERE user_id = $1
      `, [userId])

      if (result.rows.length > 0) {
        return result.rows.map(row => ({
          resource: row.resource,
          metric: row.metric,
          warningThreshold: row.warning_threshold,
          criticalThreshold: row.critical_threshold,
          enabled: row.enabled
        }))
      }
    } catch (error) {
      console.error(`Error fetching thresholds for user ${userId}:`, error)
    }

    // Return default thresholds if none found
    return DEFAULT_THRESHOLDS
  }

  private async storeViolations(violations: QuotaViolation[]): Promise<void> {
    for (const violation of violations) {
      try {
        // Check if this violation already exists recently (within last hour)
        const existingResult = await safeDb.safeSelect(`
          SELECT id FROM quota_violations 
          WHERE user_id = $1 AND resource = $2 AND violation_type = $3 
          AND severity = $4 AND created_at > NOW() - INTERVAL '1 hour'
          LIMIT 1
        `, [violation.userId, violation.resource, violation.violationType, violation.severity])

        if (existingResult.rows.length === 0) {
          // Store new violation
          await safeDb.safeInsert(`
            INSERT INTO quota_violations (
              id, user_id, resource, violation_type, current_usage, quota_limit,
              utilization_percent, severity, message, acknowledged, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            violation.id,
            violation.userId,
            violation.resource,
            violation.violationType,
            violation.currentUsage,
            violation.quotaLimit,
            violation.utilizationPercent,
            violation.severity,
            violation.message,
            violation.acknowledged,
            violation.timestamp
          ])
        }
      } catch (error) {
        console.error('Error storing violation:', error)
      }
    }
  }

  private async processAlerts(violations: QuotaViolation[]): Promise<void> {
    const groupedByUser = violations.reduce((acc, violation) => {
      if (!acc[violation.userId]) {
        acc[violation.userId] = []
      }
      acc[violation.userId].push(violation)
      return acc
    }, {} as Record<string, QuotaViolation[]>)

    for (const [userId, userViolations] of Object.entries(groupedByUser)) {
      try {
        await this.sendUserAlerts(userId, userViolations)
      } catch (error) {
        console.error(`Error sending alerts for user ${userId}:`, error)
      }
    }
  }

  private async sendUserAlerts(userId: string, violations: QuotaViolation[]): Promise<void> {
    const alertChannels = await this.getUserAlertChannels(userId)
    
    for (const channel of alertChannels) {
      if (!channel.enabled) continue

      // Filter violations by channel event subscriptions
      const relevantViolations = violations.filter(violation => {
        const eventType = this.getEventTypeForViolation(violation)
        return channel.events.includes(eventType)
      })

      if (relevantViolations.length === 0) continue

      try {
        await this.sendAlert(channel, relevantViolations)
      } catch (error) {
        console.error(`Error sending alert through channel ${channel.id}:`, error)
      }
    }
  }

  private async getUserAlertChannels(userId: string): Promise<AlertChannel[]> {
    try {
      const result = await safeDb.safeSelect(`
        SELECT * FROM quota_alert_channels 
        WHERE user_id = $1 AND enabled = TRUE
      `, [userId])

      return result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        type: row.type,
        config: JSON.parse(row.config),
        enabled: row.enabled,
        events: JSON.parse(row.events)
      }))
    } catch (error) {
      console.error(`Error fetching alert channels for user ${userId}:`, error)
      return []
    }
  }

  private getEventTypeForViolation(violation: QuotaViolation): string {
    switch (violation.severity) {
      case 'critical':
        return 'quota_critical'
      case 'high':
        return 'quota_exceeded'
      case 'medium':
        return 'quota_warning'
      default:
        return 'quota_warning'
    }
  }

  private async sendAlert(channel: AlertChannel, violations: QuotaViolation[]): Promise<void> {
    const alertData = {
      timestamp: new Date().toISOString(),
      userId: channel.userId,
      violations: violations.map(v => ({
        resource: v.resource,
        severity: v.severity,
        message: v.message,
        utilizationPercent: v.utilizationPercent,
        timestamp: v.timestamp
      })),
      summary: this.generateAlertSummary(violations)
    }

    switch (channel.type) {
      case 'webhook':
        await this.sendWebhookAlert(channel, alertData)
        break
      case 'email':
        await this.sendEmailAlert(channel, alertData)
        break
      case 'slack':
        await this.sendSlackAlert(channel, alertData)
        break
    }
  }

  private async sendWebhookAlert(channel: AlertChannel, alertData: any): Promise<void> {
    if (!channel.config.url) {
      throw new Error('Webhook URL not configured')
    }

    const response = await fetch(channel.config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Kolaybase-QuotaMonitor/1.0',
        ...(channel.config.headers || {})
      },
      body: JSON.stringify(alertData)
    })

    if (!response.ok) {
      throw new Error(`Webhook alert failed: ${response.status} ${response.statusText}`)
    }
  }

  private async sendEmailAlert(channel: AlertChannel, alertData: any): Promise<void> {
    // Email sending would be implemented with your email service
    console.log(`📧 Would send email alert to ${channel.config.email}:`, alertData.summary)
  }

  private async sendSlackAlert(channel: AlertChannel, alertData: any): Promise<void> {
    // Slack alert implementation would go here
    console.log(`📱 Would send Slack alert to ${channel.config.slackChannel}:`, alertData.summary)
  }

  private generateAlertSummary(violations: QuotaViolation[]): string {
    const criticalCount = violations.filter(v => v.severity === 'critical').length
    const highCount = violations.filter(v => v.severity === 'high').length
    const mediumCount = violations.filter(v => v.severity === 'medium').length

    let summary = `Quota Alert: ${violations.length} violation(s) detected`
    
    if (criticalCount > 0) summary += ` (${criticalCount} critical)`
    if (highCount > 0) summary += ` (${highCount} high)`
    if (mediumCount > 0) summary += ` (${mediumCount} medium)`

    return summary
  }

  private formatBytes(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
    if (bytes === 0) return '0 Bytes'
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`
  }

  // Public API methods
  async acknowledgeViolation(violationId: string, userId: string, acknowledgedBy: string): Promise<void> {
    await safeDb.safeUpdate(`
      UPDATE quota_violations 
      SET acknowledged = TRUE, acknowledged_at = NOW(), acknowledged_by = $3
      WHERE id = $1 AND user_id = $2
    `, [violationId, userId, acknowledgedBy])
  }

  async getViolationsHistory(
    userId: string, 
    limit: number = 50, 
    severity?: string
  ): Promise<QuotaViolation[]> {
    let query = `
      SELECT * FROM quota_violations 
      WHERE user_id = $1
    `
    const params = [userId]

    if (severity) {
      query += ` AND severity = $2`
      params.push(severity)
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
    params.push(limit.toString())

    const result = await safeDb.safeSelect(query, params)
    
    return result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      resource: row.resource,
      violationType: row.violation_type,
      currentUsage: row.current_usage,
      quotaLimit: row.quota_limit,
      utilizationPercent: row.utilization_percent,
      timestamp: new Date(row.created_at),
      severity: row.severity,
      message: row.message,
      acknowledged: row.acknowledged,
      acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at) : undefined,
      acknowledgedBy: row.acknowledged_by
    }))
  }

  async createAlertChannel(userId: string, channel: Omit<AlertChannel, 'id' | 'userId'>): Promise<string> {
    const id = `channel_${Date.now()}_${Math.random().toString(36).substring(2)}`
    
    await safeDb.safeInsert(`
      INSERT INTO quota_alert_channels (id, user_id, type, config, enabled, events, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      id,
      userId,
      channel.type,
      JSON.stringify(channel.config),
      channel.enabled,
      JSON.stringify(channel.events)
    ])

    return id
  }

  async updateUserThresholds(userId: string, thresholds: QuotaThreshold[]): Promise<void> {
    // Delete existing thresholds
    await safeDb.safeDelete(`DELETE FROM quota_thresholds WHERE user_id = $1`, [userId])

    // Insert new thresholds
    for (const threshold of thresholds) {
      await safeDb.safeInsert(`
        INSERT INTO quota_thresholds (
          user_id, resource, metric, warning_threshold, critical_threshold, enabled, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        userId,
        threshold.resource,
        threshold.metric,
        threshold.warningThreshold,
        threshold.criticalThreshold,
        threshold.enabled
      ])
    }
  }
}

export const quotaMonitor = QuotaMonitor.getInstance()