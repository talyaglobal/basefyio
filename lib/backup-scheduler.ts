import { dbManager } from './database-manager'
import { quotaManager } from './resource-quotas'
import { safeDb } from './db-safety'

export interface BackupSchedule {
  id: string
  name: string
  userId: string
  frequency: 'hourly' | 'daily' | 'weekly' | 'monthly'
  time?: string // HH:MM format for daily/weekly/monthly
  dayOfWeek?: number // 0-6 for weekly (0 = Sunday)
  dayOfMonth?: number // 1-31 for monthly
  enabled: boolean
  retentionDays: number
  lastRun?: Date
  nextRun: Date
  createdAt: Date
  metadata?: {
    totalBackups: number
    failedBackups: number
    avgDuration: number
  }
}

export interface BackupJob {
  id: string
  scheduleId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt: Date
  completedAt?: Date
  backupId?: string
  error?: string
  duration?: number // milliseconds
}

export class BackupScheduler {
  private schedules: Map<string, BackupSchedule> = new Map()
  private runningJobs: Map<string, BackupJob> = new Map()
  private intervalId?: NodeJS.Timeout

  constructor() {
    this.initialize()
  }

  private async initialize() {
    await this.loadSchedules()
    
    // Check for scheduled backups every minute
    this.intervalId = setInterval(() => {
      this.processSchedules()
    }, 60000) // 1 minute
  }

  private async loadSchedules() {
    try {
      const result = await safeDb.safeSelect(`
        SELECT * FROM backup_schedules 
        WHERE enabled = true
        ORDER BY next_run ASC
      `)

      for (const schedule of result.rows) {
        this.schedules.set(schedule.id, {
          id: schedule.id,
          name: schedule.name,
          userId: schedule.user_id,
          frequency: schedule.frequency,
          time: schedule.time,
          dayOfWeek: schedule.day_of_week,
          dayOfMonth: schedule.day_of_month,
          enabled: schedule.enabled,
          retentionDays: schedule.retention_days,
          lastRun: schedule.last_run ? new Date(schedule.last_run) : undefined,
          nextRun: new Date(schedule.next_run),
          createdAt: new Date(schedule.created_at),
          metadata: schedule.metadata ? JSON.parse(schedule.metadata) : undefined,
        })
      }

      console.log(`Loaded ${this.schedules.size} backup schedules`)
    } catch (error) {
      console.error('Failed to load backup schedules:', error)
    }
  }

  private async processSchedules() {
    const now = new Date()

    for (const schedule of this.schedules.values()) {
      if (schedule.enabled && schedule.nextRun <= now) {
        await this.executeBackup(schedule)
      }
    }
  }

  private async executeBackup(schedule: BackupSchedule) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const startedAt = new Date()

    const job: BackupJob = {
      id: jobId,
      scheduleId: schedule.id,
      status: 'running',
      startedAt,
    }

    this.runningJobs.set(jobId, job)

    try {
      // Check user's backup quota
      const quotaCheck = await quotaManager.checkQuotaViolation(
        schedule.userId, 
        'backup', 
        'create'
      )

      if (!quotaCheck.allowed) {
        throw new Error(`Quota violation: ${quotaCheck.message}`)
      }

      // Create backup
      const backupName = `scheduled_${schedule.name}_${Date.now()}`
      const backupId = await dbManager.createBackup(backupName, 'scheduled')

      // Update job
      job.status = 'completed'
      job.completedAt = new Date()
      job.backupId = backupId
      job.duration = job.completedAt.getTime() - startedAt.getTime()

      // Update schedule
      schedule.lastRun = startedAt
      schedule.nextRun = this.calculateNextRun(schedule)

      // Update metadata
      if (!schedule.metadata) {
        schedule.metadata = { totalBackups: 0, failedBackups: 0, avgDuration: 0 }
      }
      
      schedule.metadata.totalBackups++
      schedule.metadata.avgDuration = 
        (schedule.metadata.avgDuration + job.duration) / 2

      await this.updateSchedule(schedule)

      // Clean up old backups based on retention
      await this.cleanupOldBackups(schedule)

      console.log(`Scheduled backup completed: ${backupName} (${backupId})`)

    } catch (error: any) {
      job.status = 'failed'
      job.completedAt = new Date()
      job.error = error.message
      job.duration = job.completedAt.getTime() - startedAt.getTime()

      // Update failed backup count
      if (!schedule.metadata) {
        schedule.metadata = { totalBackups: 0, failedBackups: 0, avgDuration: 0 }
      }
      schedule.metadata.failedBackups++

      // Still update next run time
      schedule.nextRun = this.calculateNextRun(schedule)
      await this.updateSchedule(schedule)

      console.error(`Scheduled backup failed: ${schedule.name}`, error)
    }

    // Save job record
    await this.saveJob(job)
    
    // Remove from running jobs after a delay (for monitoring)
    setTimeout(() => {
      this.runningJobs.delete(jobId)
    }, 300000) // Keep for 5 minutes
  }

  private calculateNextRun(schedule: BackupSchedule): Date {
    const now = new Date()
    let nextRun: Date

    switch (schedule.frequency) {
      case 'hourly':
        nextRun = new Date(now.getTime() + 60 * 60 * 1000) // +1 hour
        break

      case 'daily':
        nextRun = new Date(now)
        nextRun.setDate(nextRun.getDate() + 1)
        if (schedule.time) {
          const [hours, minutes] = schedule.time.split(':').map(Number)
          nextRun.setHours(hours, minutes, 0, 0)
        }
        break

      case 'weekly':
        nextRun = new Date(now)
        nextRun.setDate(nextRun.getDate() + 7)
        if (schedule.dayOfWeek !== undefined) {
          const daysUntilTarget = (schedule.dayOfWeek + 7 - nextRun.getDay()) % 7
          nextRun.setDate(nextRun.getDate() + daysUntilTarget)
        }
        if (schedule.time) {
          const [hours, minutes] = schedule.time.split(':').map(Number)
          nextRun.setHours(hours, minutes, 0, 0)
        }
        break

      case 'monthly':
        nextRun = new Date(now)
        nextRun.setMonth(nextRun.getMonth() + 1)
        if (schedule.dayOfMonth) {
          nextRun.setDate(Math.min(schedule.dayOfMonth, new Date(nextRun.getFullYear(), nextRun.getMonth() + 1, 0).getDate()))
        }
        if (schedule.time) {
          const [hours, minutes] = schedule.time.split(':').map(Number)
          nextRun.setHours(hours, minutes, 0, 0)
        }
        break

      default:
        nextRun = new Date(now.getTime() + 24 * 60 * 60 * 1000) // +1 day fallback
    }

    return nextRun
  }

  private async updateSchedule(schedule: BackupSchedule) {
    await safeDb.safeUpdate(`
      UPDATE backup_schedules 
      SET last_run = $1, next_run = $2, metadata = $3
      WHERE id = $4
    `, [
      schedule.lastRun,
      schedule.nextRun,
      JSON.stringify(schedule.metadata),
      schedule.id
    ])
  }

  private async saveJob(job: BackupJob) {
    await safeDb.safeInsert(`
      INSERT INTO backup_jobs (
        id, schedule_id, status, started_at, completed_at, 
        backup_id, error, duration
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      job.id,
      job.scheduleId,
      job.status,
      job.startedAt,
      job.completedAt,
      job.backupId,
      job.error,
      job.duration
    ])
  }

  private async cleanupOldBackups(schedule: BackupSchedule) {
    try {
      const allBackups = await dbManager.listBackups()
      const scheduleBackups = allBackups
        .filter(backup => 
          backup.name.includes(`scheduled_${schedule.name}`) &&
          backup.type === 'scheduled'
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - schedule.retentionDays)

      // Delete old backups
      for (const backup of scheduleBackups) {
        if (backup.createdAt < cutoffDate) {
          await dbManager.deleteBackup(backup.id)
          console.log(`Cleaned up old backup: ${backup.name}`)
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old backups:', error)
    }
  }

  async createSchedule(schedule: Omit<BackupSchedule, 'id' | 'createdAt' | 'nextRun'>): Promise<string> {
    const id = `sched_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const createdAt = new Date()
    const nextRun = this.calculateNextRun({ ...schedule, id, createdAt, nextRun: new Date() } as BackupSchedule)

    const fullSchedule: BackupSchedule = {
      ...schedule,
      id,
      createdAt,
      nextRun,
    }

    await safeDb.safeInsert(`
      INSERT INTO backup_schedules (
        id, name, user_id, frequency, time, day_of_week, day_of_month,
        enabled, retention_days, next_run, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      id, schedule.name, schedule.userId, schedule.frequency,
      schedule.time, schedule.dayOfWeek, schedule.dayOfMonth,
      schedule.enabled, schedule.retentionDays, nextRun, createdAt
    ])

    this.schedules.set(id, fullSchedule)
    console.log(`Created backup schedule: ${schedule.name}`)

    return id
  }

  async updateScheduleConfig(scheduleId: string, updates: Partial<BackupSchedule>): Promise<void> {
    const schedule = this.schedules.get(scheduleId)
    if (!schedule) {
      throw new Error('Schedule not found')
    }

    // Update schedule object
    Object.assign(schedule, updates)
    
    // Recalculate next run if frequency or timing changed
    if (updates.frequency || updates.time || updates.dayOfWeek || updates.dayOfMonth) {
      schedule.nextRun = this.calculateNextRun(schedule)
    }

    // Update database
    await safeDb.safeUpdate(`
      UPDATE backup_schedules 
      SET name = $1, frequency = $2, time = $3, day_of_week = $4, 
          day_of_month = $5, enabled = $6, retention_days = $7, next_run = $8
      WHERE id = $9
    `, [
      schedule.name, schedule.frequency, schedule.time, schedule.dayOfWeek,
      schedule.dayOfMonth, schedule.enabled, schedule.retentionDays,
      schedule.nextRun, scheduleId
    ])

    console.log(`Updated backup schedule: ${scheduleId}`)
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await safeDb.safeDelete(`DELETE FROM backup_schedules WHERE id = $1`, [scheduleId])
    this.schedules.delete(scheduleId)
    console.log(`Deleted backup schedule: ${scheduleId}`)
  }

  getSchedules(): BackupSchedule[] {
    return Array.from(this.schedules.values())
  }

  getSchedule(scheduleId: string): BackupSchedule | undefined {
    return this.schedules.get(scheduleId)
  }

  getRunningJobs(): BackupJob[] {
    return Array.from(this.runningJobs.values())
  }

  async getJobHistory(scheduleId?: string, limit: number = 50): Promise<BackupJob[]> {
    let query = `
      SELECT * FROM backup_jobs 
      ${scheduleId ? 'WHERE schedule_id = $1' : ''}
      ORDER BY started_at DESC 
      LIMIT ${limit}
    `
    
    const params = scheduleId ? [scheduleId] : []
    const result = await safeDb.safeSelect(query, params)

    return result.rows.map(row => ({
      id: row.id,
      scheduleId: row.schedule_id,
      status: row.status,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      backupId: row.backup_id,
      error: row.error,
      duration: row.duration,
    }))
  }

  async pauseSchedule(scheduleId: string): Promise<void> {
    await this.updateScheduleConfig(scheduleId, { enabled: false })
  }

  async resumeSchedule(scheduleId: string): Promise<void> {
    const schedule = this.schedules.get(scheduleId)
    if (schedule) {
      schedule.nextRun = this.calculateNextRun(schedule)
      await this.updateScheduleConfig(scheduleId, { enabled: true, nextRun: schedule.nextRun })
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
  }
}

// Global backup scheduler instance
export const backupScheduler = new BackupScheduler()