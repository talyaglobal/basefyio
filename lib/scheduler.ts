import { CronJob } from 'cron'
import { safeDb } from './db-safety'
import { edgeFunctionRuntime } from './edge-functions'

export interface ScheduledJob {
  id: string
  name: string
  description?: string
  cron_expression: string
  function_id?: string
  webhook_url?: string
  payload: Record<string, any>
  timezone: string
  is_active: boolean
  next_run_at?: string
  last_run_at?: string
  last_run_status?: 'success' | 'error' | 'timeout'
  last_error_message?: string
  created_by: string
}

export interface JobRun {
  id: string
  job_id: string
  status: 'running' | 'success' | 'error' | 'timeout'
  started_at: string
  completed_at?: string
  execution_time_ms?: number
  output?: string
  error_message?: string
  logs: string
}

export class JobScheduler {
  private jobs: Map<string, CronJob> = new Map()
  private runningJobs: Map<string, AbortController> = new Map()

  constructor() {
    this.loadAndScheduleJobs()
    
    // Check for jobs every minute in case of missed schedules
    setInterval(() => {
      this.checkMissedJobs()
    }, 60000)
  }

  private async loadAndScheduleJobs() {
    try {
      const result = await safeDb.safeSelect(`
        SELECT * FROM scheduled_jobs 
        WHERE is_active = TRUE 
        AND (next_run_at IS NULL OR next_run_at <= NOW() + INTERVAL '1 hour')
        ORDER BY created_at
      `)

      for (const jobData of result.rows) {
        await this.scheduleJob(jobData)
      }

      console.log(`📅 Loaded ${result.rows.length} scheduled jobs`)
    } catch (error) {
      console.error('Failed to load scheduled jobs:', error)
    }
  }

  private async scheduleJob(jobData: ScheduledJob) {
    try {
      // Remove existing job if it exists
      if (this.jobs.has(jobData.id)) {
        this.jobs.get(jobData.id)?.stop()
        this.jobs.delete(jobData.id)
      }

      const cronJob = new CronJob(
        jobData.cron_expression,
        () => this.executeJob(jobData),
        null,
        false,
        jobData.timezone
      )

      // Calculate next run time
      const nextRun = cronJob.nextDate()
      await safeDb.safeUpdate(`
        UPDATE scheduled_jobs 
        SET next_run_at = $2 
        WHERE id = $1
      `, [jobData.id, nextRun.toISO()])

      cronJob.start()
      this.jobs.set(jobData.id, cronJob)

      console.log(`⏰ Scheduled job: ${jobData.name} (next run: ${nextRun.toISO()})`)
    } catch (error) {
      console.error(`Failed to schedule job ${jobData.name}:`, error)
    }
  }

  private async executeJob(jobData: ScheduledJob) {
    const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2)}`
    const startTime = Date.now()
    let logs = ''

    console.log(`🚀 Executing job: ${jobData.name}`)

    // Create job run record
    await safeDb.safeInsert(`
      INSERT INTO scheduled_job_runs (id, job_id, status, started_at)
      VALUES ($1, $2, 'running', NOW())
    `, [runId, jobData.id])

    const abortController = new AbortController()
    this.runningJobs.set(runId, abortController)

    try {
      let result: any

      if (jobData.function_id) {
        // Execute edge function
        result = await this.executeEdgeFunction(jobData, abortController.signal)
      } else if (jobData.webhook_url) {
        // Execute webhook
        result = await this.executeWebhook(jobData, abortController.signal)
      } else {
        throw new Error('No function or webhook configured for job')
      }

      const executionTime = Date.now() - startTime
      logs = result.logs || ''

      // Update job run as successful
      await safeDb.safeUpdate(`
        UPDATE scheduled_job_runs 
        SET status = 'success', completed_at = NOW(), 
            execution_time_ms = $3, output = $4, logs = $5
        WHERE id = $1 AND job_id = $2
      `, [runId, jobData.id, executionTime, JSON.stringify(result.output), logs])

      // Update job last run status
      await safeDb.safeUpdate(`
        UPDATE scheduled_jobs 
        SET last_run_at = NOW(), last_run_status = 'success', 
            last_error_message = NULL
        WHERE id = $1
      `, [jobData.id])

      console.log(`✅ Job completed successfully: ${jobData.name} (${executionTime}ms)`)

    } catch (error: any) {
      const executionTime = Date.now() - startTime
      const isTimeout = error.name === 'TimeoutError' || abortController.signal.aborted

      // Update job run as failed
      await safeDb.safeUpdate(`
        UPDATE scheduled_job_runs 
        SET status = $3, completed_at = NOW(), 
            execution_time_ms = $4, error_message = $5, logs = $6
        WHERE id = $1 AND job_id = $2
      `, [
        runId, 
        jobData.id, 
        isTimeout ? 'timeout' : 'error',
        executionTime,
        error.message,
        logs
      ])

      // Update job last run status
      await safeDb.safeUpdate(`
        UPDATE scheduled_jobs 
        SET last_run_at = NOW(), last_run_status = $2, 
            last_error_message = $3
        WHERE id = $1
      `, [jobData.id, isTimeout ? 'timeout' : 'error', error.message])

      console.error(`❌ Job failed: ${jobData.name}`, error.message)
    } finally {
      this.runningJobs.delete(runId)

      // Calculate and update next run time
      const cronJob = this.jobs.get(jobData.id)
      if (cronJob) {
        const nextRun = cronJob.nextDate()
        await safeDb.safeUpdate(`
          UPDATE scheduled_jobs 
          SET next_run_at = $2 
          WHERE id = $1
        `, [jobData.id, nextRun.toISO()])
      }
    }
  }

  private async executeEdgeFunction(jobData: ScheduledJob, signal: AbortSignal): Promise<any> {
    if (!jobData.function_id) {
      throw new Error('No function ID provided')
    }

    // Get function details
    const functionResult = await safeDb.safeSelect(`
      SELECT * FROM edge_functions WHERE id = $1 AND is_active = TRUE
    `, [jobData.function_id])

    if (functionResult.rows.length === 0) {
      throw new Error('Function not found or inactive')
    }

    const func = functionResult.rows[0]

    // Create execution context for scheduled job
    const context = {
      function_id: func.id,
      request: {
        method: 'POST',
        url: `internal://scheduled-job/${jobData.id}`,
        headers: {
          'Content-Type': 'application/json',
          'X-Kolaybase-Job-Id': jobData.id,
          'X-Kolaybase-Job-Name': jobData.name
        },
        body: jobData.payload
      },
      secrets: {},
      environment: func.environment_variables || {}
    }

    // Execute the function with timeout
    return await Promise.race([
      edgeFunctionRuntime.invokeFunction(func, context),
      new Promise((_, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Function execution timeout'))
        }, func.timeout_ms || 30000)

        signal.addEventListener('abort', () => {
          clearTimeout(timeout)
          reject(new Error('Function execution aborted'))
        })
      })
    ])
  }

  private async executeWebhook(jobData: ScheduledJob, signal: AbortSignal): Promise<any> {
    if (!jobData.webhook_url) {
      throw new Error('No webhook URL provided')
    }

    // Handle internal webhooks (for system jobs like quota monitoring)
    if (jobData.webhook_url.startsWith('internal://')) {
      return await this.executeInternalWebhook(jobData)
    }

    const controller = new AbortController()
    signal.addEventListener('abort', () => controller.abort())

    // Set timeout for webhook
    const timeout = setTimeout(() => controller.abort(), 30000) // 30 second timeout

    try {
      const response = await fetch(jobData.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Kolaybase-Scheduler/1.0',
          'X-Kolaybase-Job-Id': jobData.id,
          'X-Kolaybase-Job-Name': jobData.name
        },
        body: JSON.stringify(jobData.payload),
        signal: controller.signal
      })

      clearTimeout(timeout)

      const responseText = await response.text()
      let responseData

      try {
        responseData = JSON.parse(responseText)
      } catch {
        responseData = responseText
      }

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}: ${responseText}`)
      }

      return {
        output: responseData,
        logs: `Webhook executed successfully. Status: ${response.status}`
      }

    } catch (error: any) {
      clearTimeout(timeout)
      
      if (error.name === 'AbortError') {
        throw new Error('Webhook request timeout')
      }
      
      throw error
    }
  }

  private async executeInternalWebhook(jobData: ScheduledJob): Promise<any> {
    if (!jobData.webhook_url) {
      throw new Error('No webhook URL provided')
    }
    
    const url = new URL(jobData.webhook_url)
    const path = url.pathname.substring(1) // Remove leading slash

    switch (path) {
      case 'quota-monitor':
        const { quotaMonitor } = await import('./quota-monitor')
        const violations = await quotaMonitor.checkAllUserQuotas()
        return {
          output: { 
            violationsDetected: violations.length,
            violations: violations.map(v => ({
              userId: v.userId,
              resource: v.resource,
              severity: v.severity,
              message: v.message
            }))
          },
          logs: `Quota monitoring completed. Found ${violations.length} violations.`
        }
      
      default:
        throw new Error(`Unknown internal webhook: ${path}`)
    }
  }

  private async checkMissedJobs() {
    try {
      // Find jobs that should have run but didn't
      const result = await safeDb.safeSelect(`
        SELECT * FROM scheduled_jobs 
        WHERE is_active = TRUE 
        AND next_run_at <= NOW()
        AND id NOT IN (
          SELECT DISTINCT job_id FROM scheduled_job_runs 
          WHERE status = 'running'
        )
      `)

      for (const jobData of result.rows) {
        console.log(`⚠️ Found missed job: ${jobData.name}`)
        await this.executeJob(jobData)
      }
    } catch (error) {
      console.error('Failed to check missed jobs:', error)
    }
  }

  async createJob(jobData: Omit<ScheduledJob, 'id' | 'next_run_at' | 'last_run_at' | 'last_run_status' | 'last_error_message'>): Promise<string> {
    // Validate cron expression
    try {
      new CronJob(jobData.cron_expression, () => {}, null, false, jobData.timezone)
    } catch (error) {
      throw new Error(`Invalid cron expression: ${jobData.cron_expression}`)
    }

    const result = await safeDb.safeInsert(`
      INSERT INTO scheduled_jobs (
        name, description, cron_expression, function_id, webhook_url, 
        payload, timezone, is_active, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id, name, cron_expression, timezone, is_active
    `, [
      jobData.name,
      jobData.description,
      jobData.cron_expression,
      jobData.function_id,
      jobData.webhook_url,
      JSON.stringify(jobData.payload),
      jobData.timezone,
      jobData.is_active,
      jobData.created_by
    ])

    const job = result.rows[0]

    if (job.is_active) {
      await this.scheduleJob({ ...jobData, id: job.id })
    }

    return job.id
  }

  async updateJob(jobId: string, updates: Partial<ScheduledJob>): Promise<void> {
    // Update database
    const setClause = Object.keys(updates)
      .filter(key => key !== 'id')
      .map((key, index) => `${key} = $${index + 2}`)
      .join(', ')

    const values = [jobId, ...Object.values(updates).filter((_, index) => 
      Object.keys(updates)[index] !== 'id'
    )]

    await safeDb.safeUpdate(`
      UPDATE scheduled_jobs 
      SET ${setClause}, updated_at = NOW()
      WHERE id = $1
    `, values)

    // Reload job if it exists
    if (this.jobs.has(jobId)) {
      const result = await safeDb.safeSelect(`
        SELECT * FROM scheduled_jobs WHERE id = $1
      `, [jobId])

      if (result.rows.length > 0) {
        await this.scheduleJob(result.rows[0])
      }
    }
  }

  async deleteJob(jobId: string): Promise<void> {
    // Stop and remove from scheduler
    if (this.jobs.has(jobId)) {
      this.jobs.get(jobId)?.stop()
      this.jobs.delete(jobId)
    }

    // Abort any running executions
    for (const [runId, controller] of this.runningJobs) {
      if (runId.includes(jobId)) {
        controller.abort()
        this.runningJobs.delete(runId)
      }
    }

    // Soft delete from database
    await safeDb.safeUpdate(`
      UPDATE scheduled_jobs 
      SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1
    `, [jobId])
  }

  async getJobRuns(jobId: string, limit: number = 50): Promise<JobRun[]> {
    const result = await safeDb.safeSelect(`
      SELECT * FROM scheduled_job_runs 
      WHERE job_id = $1 
      ORDER BY started_at DESC 
      LIMIT $2
    `, [jobId, limit])

    return result.rows
  }

  getRunningJobsCount(): number {
    return this.runningJobs.size
  }

  getActiveJobsCount(): number {
    return this.jobs.size
  }

  async getJobMetrics(jobId: string, since?: Date): Promise<{
    totalRuns: number
    successRate: number
    averageExecutionTime: number
    lastRun?: string
    nextRun?: string
  }> {
    let query = `
      SELECT 
        COUNT(*) as total_runs,
        AVG(execution_time_ms) as avg_execution_time,
        COUNT(CASE WHEN status = 'success' THEN 1 END) as success_count,
        MAX(started_at) as last_run
      FROM scheduled_job_runs 
      WHERE job_id = $1
    `
    
    const params = [jobId]
    
    if (since) {
      query += ` AND started_at >= $2`
      params.push(since.toISOString())
    }

    const [metricsResult, jobResult] = await Promise.all([
      safeDb.safeSelect(query, params),
      safeDb.safeSelect(`
        SELECT next_run_at FROM scheduled_jobs WHERE id = $1
      `, [jobId])
    ])

    const metrics = metricsResult.rows[0]
    const job = jobResult.rows[0]

    return {
      totalRuns: parseInt(metrics.total_runs),
      successRate: metrics.total_runs > 0 
        ? (metrics.success_count / metrics.total_runs) * 100 
        : 0,
      averageExecutionTime: parseFloat(metrics.avg_execution_time) || 0,
      lastRun: metrics.last_run,
      nextRun: job?.next_run_at
    }
  }
}

export const jobScheduler = new JobScheduler()