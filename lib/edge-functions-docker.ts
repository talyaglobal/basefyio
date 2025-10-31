// Enhanced Edge Functions Runtime with Docker-based isolation
import { safeDb } from './db-safety'

// Disable Docker functionality completely for build compatibility
const DOCKER_ENABLED = false

// Stub Docker types
type Docker = any
type Container = any
type ContainerInfo = any

// Type definitions for Node.js modules
type FSPromises = typeof import('fs').promises
type PathJoin = typeof import('path').join

// Lazy load Node.js modules
async function getNodeModules() {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error('Node.js runtime required')
  }
  
  const [fsModule, pathModule] = await Promise.all([
    import('fs'),
    import('path')
  ])
  
  return {
    fs: fsModule.promises as FSPromises,
    join: pathModule.join as PathJoin
  }
}

export interface EdgeFunction {
  id: string
  name: string
  slug: string
  description?: string
  runtime: 'deno' | 'node'
  source_code: string
  environment_variables: Record<string, string>
  timeout_ms: number
  memory_limit_mb: number
  cpu_limit?: number // CPU shares (1-1024)
  is_active: boolean
  version: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface InvocationContext {
  function_id: string
  user_id?: string
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body?: any
  }
  secrets: Record<string, string>
  environment: Record<string, string>
}

export interface RetryConfig {
  maxRetries: number
  initialDelay: number
  maxDelay: number
  backoffMultiplier: number
}

interface ContainerPoolEntry {
  container: Container
  lastUsed: number
  functionId: string
  inUse: boolean
}

export class DockerEdgeFunctionRuntime {
  private docker: Docker | null = null
  private tempDir: string = ''
  private nodeModules: Awaited<ReturnType<typeof getNodeModules>> | null = null
  private containerPool: Map<string, ContainerPoolEntry[]> = new Map()
  private maxPoolSize: number = 5 // Max containers per function in pool
  private poolCleanupInterval: NodeJS.Timeout | null = null
  private dockerModules: { Docker: any, tar: any } | null = null
  private defaultRetryConfig: RetryConfig = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2
  }

  constructor() {
    this.initializeDocker()
    this.initializeTempDir()
    this.startPoolCleanup()
  }

  private async initializeDocker() {
    if (!DOCKER_ENABLED) {
      console.warn('⚠️ Docker functionality disabled for build compatibility')
      this.docker = null
      return
    }

    try {
      // Dynamically import Docker modules only when needed
      const [dockerModule, tarModule] = await Promise.all([
        import('dockerode'),
        import('tar-fs')
      ])
      
      this.dockerModules = {
        Docker: dockerModule.default,
        tar: tarModule
      }

      // Try to connect to Docker daemon
      this.docker = new this.dockerModules.Docker()
      
      // Test connection
      await this.docker.ping()
      console.log('✅ Docker daemon connected')
    } catch (error) {
      console.warn('⚠️ Docker not available, falling back to direct execution:', error)
      this.docker = null
    }
  }

  private async initializeTempDir() {
    try {
      const modules = await getNodeModules()
      this.nodeModules = modules
      this.tempDir = modules.join(process.cwd(), '.kolaybase', 'functions')
      await this.ensureTempDir()
    } catch (error) {
      console.warn('Failed to initialize Node.js modules:', error)
    }
  }

  private async ensureTempDir() {
    if (!this.nodeModules) {
      await this.initializeTempDir()
    }
    try {
      await this.nodeModules!.fs.mkdir(this.tempDir, { recursive: true })
    } catch (error) {
      console.error('Failed to create temp directory:', error)
    }
  }

  /**
   * Deploy function with Docker image building
   */
  async deployFunction(func: EdgeFunction): Promise<void> {
    if (!this.nodeModules) {
      await this.initializeTempDir()
    }
    const modules = this.nodeModules!

    const functionDir = modules.join(this.tempDir, func.slug, `v${func.version}`)
    await modules.fs.mkdir(functionDir, { recursive: true })

    // Write function source code
    const sourceFile = func.runtime === 'deno' ? 'index.ts' : 'index.js'
    await modules.fs.writeFile(modules.join(functionDir, sourceFile), func.source_code)

    // Create Dockerfile for the function
    const dockerfile = this.generateDockerfile(func.runtime, sourceFile)
    await modules.fs.writeFile(modules.join(functionDir, 'Dockerfile'), dockerfile)

    // Create .dockerignore
    await modules.fs.writeFile(
      modules.join(functionDir, '.dockerignore'),
      'node_modules\n.git\n.env\n*.log\n'
    )

    // Build Docker image if Docker is available
    if (this.docker) {
      try {
        const imageTag = `kolaybase-fn-${func.slug}:v${func.version}`
        await this.buildDockerImage(functionDir, imageTag, func)
        console.log(`📦 Function ${func.slug} v${func.version} deployed with Docker`)
      } catch (error) {
        console.error(`Failed to build Docker image for ${func.slug}:`, error)
        // Continue without Docker image - will use fallback
      }
    }

    // Update deployment timestamp
    await safeDb.safeUpdate(`
      UPDATE edge_functions 
      SET deployed_at = NOW() 
      WHERE id = $1
    `, [func.id])
  }

  /**
   * Invoke function with retry mechanism and Docker isolation
   */
  async invokeFunction(
    func: EdgeFunction,
    context: InvocationContext,
    retryConfig?: Partial<RetryConfig>
  ): Promise<{
    success: boolean
    result?: any
    error?: string
    logs: string
    executionTime: number
    memoryUsed: number
    attempts: number
  }> {
    const config = { ...this.defaultRetryConfig, ...retryConfig }
    let lastError: Error | null = null
    let attempts = 0
    let delay = config.initialDelay

    for (attempts = 0; attempts <= config.maxRetries; attempts++) {
      if (attempts > 0) {
        // Wait before retry
        await this.sleep(delay)
        delay = Math.min(delay * config.backoffMultiplier, config.maxDelay)
      }

      try {
        const result = await this.executeFunction(func, context)
        return {
          ...result,
          attempts: attempts + 1
        }
      } catch (error: any) {
        lastError = error
        
        // Don't retry on timeout or user errors
        if (error.message?.includes('timeout') || error.message?.includes('validation')) {
          break
        }

        // Last attempt
        if (attempts === config.maxRetries) {
          break
        }
      }
    }

    // All retries failed
    const executionTime = Date.now()
    await this.logInvocation({
      function_id: func.id,
      execution_time_ms: 0,
      memory_used_mb: 0,
      status: 'error',
      request_size_bytes: JSON.stringify(context.request).length,
      response_size_bytes: 0,
      error_message: lastError?.message || 'All retry attempts failed',
      logs: `Failed after ${attempts + 1} attempts`,
      invoked_at: new Date().toISOString()
    })

    return {
      success: false,
      error: lastError?.message || 'Execution failed',
      logs: `Failed after ${attempts + 1} attempts: ${lastError?.message}`,
      executionTime: 0,
      memoryUsed: 0,
      attempts: attempts + 1
    }
  }

  /**
   * Execute function in Docker container or fallback to direct execution
   */
  private async executeFunction(
    func: EdgeFunction,
    context: InvocationContext
  ): Promise<{
    success: boolean
    result?: any
    error?: string
    logs: string
    executionTime: number
    memoryUsed: number
  }> {
    const startTime = Date.now()
    let logs = ''
    let memoryUsed = 0

    try {
      if (this.docker) {
        // Use Docker execution
        const result = await this.executeInDocker(func, context)
        const executionTime = Date.now() - startTime

        await this.logInvocation({
          function_id: func.id,
          execution_time_ms: executionTime,
          memory_used_mb: result.memoryUsed,
          status: 'success',
          request_size_bytes: JSON.stringify(context.request).length,
          response_size_bytes: JSON.stringify(result.result).length,
          logs: result.logs,
          invoked_at: new Date().toISOString()
        })

        return {
          success: true,
          result: result.result,
          logs: result.logs,
          executionTime,
          memoryUsed: result.memoryUsed
        }
      } else {
        // Fallback to direct execution using standard runtime
        // Import dynamically to avoid circular dependency
        const { edgeFunctionRuntime } = await import('./edge-functions')
        const result = await edgeFunctionRuntime.invokeFunction(func, context)
        const executionTime = Date.now() - startTime
        
        await this.logInvocation({
          function_id: func.id,
          execution_time_ms: executionTime,
          memory_used_mb: result.memoryUsed,
          status: result.success ? 'success' : 'error',
          request_size_bytes: JSON.stringify(context.request).length,
          response_size_bytes: result.success ? JSON.stringify(result.result).length : 0,
          error_message: result.error,
          logs: result.logs,
          invoked_at: new Date().toISOString()
        })

        if (!result.success) {
          throw new Error(result.error || 'Execution failed')
        }

        return {
          success: true,
          result: result.result,
          logs: result.logs,
          executionTime,
          memoryUsed: result.memoryUsed
        }
      }
    } catch (error: any) {
      const executionTime = Date.now() - startTime
      
      // Determine if it's a timeout
      const isTimeout = error.message?.includes('timeout') || executionTime >= func.timeout_ms

      await this.logInvocation({
        function_id: func.id,
        execution_time_ms: executionTime,
        memory_used_mb: memoryUsed,
        status: isTimeout ? 'timeout' : 'error',
        request_size_bytes: JSON.stringify(context.request).length,
        response_size_bytes: 0,
        error_message: error.message,
        logs,
        invoked_at: new Date().toISOString()
      })

      throw error
    }
  }

  /**
   * Execute function in Docker container with resource limits
   */
  private async executeInDocker(
    func: EdgeFunction,
    context: InvocationContext
  ): Promise<{
    result: any
    logs: string
    memoryUsed: number
  }> {
    if (!this.docker) {
      throw new Error('Docker not available')
    }

    const imageTag = `kolaybase-fn-${func.slug}:v${func.version}`
    let container: Container | null = null
    let fromPool = false

    try {
      // Try to get container from pool
      container = await this.getPooledContainer(func.id, imageTag)
      
      if (!container) {
        // Create new container
        container = await this.createContainer(func, imageTag, context)
      } else {
        fromPool = true
      }

      // Execute function in container
      const result = await this.runContainer(container, func, context)

      // Return container to pool if not in use
      if (fromPool) {
        await this.returnContainerToPool(func.id, container)
      } else {
        // Add to pool for future use
        await this.addContainerToPool(func.id, container, imageTag)
      }

      return result
    } catch (error: any) {
      // If container creation failed, try direct execution fallback
      if (!fromPool && container) {
        try {
          await container.remove({ force: true })
        } catch {}
      }
      throw error
    }
  }

  /**
   * Create Docker container for function execution
   */
  private async createContainer(
    func: EdgeFunction,
    imageTag: string,
    context: InvocationContext
  ): Promise<Container> {
    if (!this.docker) {
      throw new Error('Docker not available')
    }

    // Convert memory limit from MB to bytes
    const memoryBytes = func.memory_limit_mb * 1024 * 1024

    // CPU limit (as percentage of one CPU core, 0.01 = 1%)
    const cpuPercent = func.cpu_limit || 100 // Default to 100% of one core

    const container = await this.docker.createContainer({
      Image: imageTag,
      Cmd: ['node', 'index.js'], // Entrypoint depends on runtime
      Env: [
        ...Object.entries(func.environment_variables).map(([k, v]) => `${k}=${v}`),
        `KOLAYBASE_CONTEXT=${JSON.stringify(context)}`
      ],
      HostConfig: {
        Memory: memoryBytes,
        MemorySwap: memoryBytes, // Disable swap
        CpuShares: Math.floor(cpuPercent * 1024 / 100), // Convert percentage to shares
        CpuPeriod: 100000, // 100ms period
        CpuQuota: Math.floor(cpuPercent * 1000), // Microseconds
        NetworkMode: 'none', // Isolated network
        ReadonlyRootfs: true, // Read-only filesystem for security
        AutoRemove: false, // We manage container lifecycle
        SecurityOpt: ['no-new-privileges:true'], // Prevent privilege escalation
      },
      WorkingDir: '/app',
    })

    return container
  }

  /**
   * Run function in container
   */
  private async runContainer(
    container: Container,
    func: EdgeFunction,
    context: InvocationContext
  ): Promise<{
    result: any
    logs: string
    memoryUsed: number
  }> {
    await container.start()

    // Set up timeout
    const timeout = setTimeout(async () => {
      try {
        await container.kill()
      } catch {}
    }, func.timeout_ms)

    try {
      // Wait for container to finish
      const waitResult = await container.wait()
      clearTimeout(timeout)

      // Get logs
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        timestamps: false
      })

      const logOutput = logs.toString('utf-8')

      // Get container stats for memory usage
      const stats = await container.stats({ stream: false })
      const memoryUsed = Math.round(
        (stats.memory_stats.usage || 0) / (1024 * 1024)
      )

      // Stop container
      try {
        await container.stop()
      } catch {}

      if (waitResult.StatusCode !== 0) {
        throw new Error(`Container exited with code ${waitResult.StatusCode}: ${logOutput}`)
      }

      // Parse result from logs (last JSON line)
      const lines = logOutput.trim().split('\n')
      let result: any = null

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          result = JSON.parse(lines[i])
          break
        } catch {
          // Not JSON, continue
        }
      }

      if (!result) {
        result = { output: logOutput }
      }

      return {
        result,
        logs: logOutput,
        memoryUsed
      }
    } catch (error: any) {
      clearTimeout(timeout)
      try {
        await container.kill()
        await container.remove({ force: true })
      } catch {}
      throw error
    }
  }

  /**
   * Build Docker image for function
   */
  private async buildDockerImage(
    functionDir: string,
    imageTag: string,
    func: EdgeFunction
  ): Promise<void> {
    if (!this.docker || !this.dockerModules) {
      throw new Error('Docker not available')
    }

    return new Promise((resolve, reject) => {
      // Build using tar stream from directory
      const tarStream = this.dockerModules!.tar.pack(functionDir)

      this.docker!.buildImage(
        tarStream,
        {
          t: imageTag,
          rm: true,
          forcerm: true,
        },
        (error: any, stream: any) => {
          if (error) {
            reject(error)
            return
          }

          if (!stream) {
            reject(new Error('Build stream not available'))
            return
          }

          // Monitor build progress
          this.docker!.modem.followProgress(stream, (err: any, output: any) => {
            if (err) {
              reject(err)
            } else {
              console.log(`✅ Docker image built: ${imageTag}`)
              resolve(undefined)
            }
          }, (event: any) => {
            // Log build progress (optional, comment out for cleaner logs)
            // if (event.stream) {
            //   process.stdout.write(event.stream)
            // }
          })
        }
      )
    })
  }

  /**
   * Generate Dockerfile for function runtime
   */
  private generateDockerfile(runtime: 'deno' | 'node', sourceFile: string): string {
    if (runtime === 'deno') {
      return `
FROM denoland/deno:latest

WORKDIR /app

COPY ${sourceFile} ./

# Deno runtime will execute the TypeScript file directly
CMD ["deno", "run", "--allow-all", "${sourceFile}"]
      `.trim()
    } else {
      return `
FROM node:20-alpine

WORKDIR /app

# Copy function code
COPY ${sourceFile} ./

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \\
    adduser -S nodejs -u 1001 && \\
    chown -R nodejs:nodejs /app

USER nodejs

CMD ["node", "${sourceFile}"]
      `.trim()
    }
  }

  /**
   * Container pooling for cold start optimization
   */
  private async getPooledContainer(
    functionId: string,
    imageTag: string
  ): Promise<Container | null> {
    const pool = this.containerPool.get(functionId) || []
    
    // Find available container
    for (const entry of pool) {
      if (!entry.inUse) {
        entry.inUse = true
        entry.lastUsed = Date.now()
        
        // Verify container is still running
        try {
          await entry.container.inspect()
          return entry.container
        } catch {
          // Container is dead, remove from pool
          const index = pool.indexOf(entry)
          pool.splice(index, 1)
        }
      }
    }

    return null
  }

  private async addContainerToPool(
    functionId: string,
    container: Container,
    imageTag: string
  ): Promise<void> {
    const pool = this.containerPool.get(functionId) || []
    
    if (pool.length >= this.maxPoolSize) {
      // Remove oldest unused container
      const oldest = pool
        .filter(e => !e.inUse)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0]
      
      if (oldest) {
        try {
          await oldest.container.remove({ force: true })
        } catch {}
        const index = pool.indexOf(oldest)
        pool.splice(index, 1)
      }
    }

    pool.push({
      container,
      lastUsed: Date.now(),
      functionId,
      inUse: false
    })

    this.containerPool.set(functionId, pool)
  }

  private async returnContainerToPool(functionId: string, container: Container): Promise<void> {
    const pool = this.containerPool.get(functionId) || []
    
    const entry = pool.find(e => e.container.id === container.id)
    if (entry) {
      entry.inUse = false
      entry.lastUsed = Date.now()
    }
  }

  /**
   * Cleanup unused containers from pool
   */
  private startPoolCleanup() {
    this.poolCleanupInterval = setInterval(async () => {
      const now = Date.now()
      const maxAge = 5 * 60 * 1000 // 5 minutes

      for (const [functionId, pool] of this.containerPool.entries()) {
        const toRemove: ContainerPoolEntry[] = []

        for (const entry of pool) {
          if (!entry.inUse && (now - entry.lastUsed) > maxAge) {
            toRemove.push(entry)
          }
        }

        for (const entry of toRemove) {
          try {
            await entry.container.remove({ force: true })
          } catch {}
          const index = pool.indexOf(entry)
          pool.splice(index, 1)
        }

        if (pool.length === 0) {
          this.containerPool.delete(functionId)
        }
      }
    }, 60000) // Run every minute
  }

  /**
   * Log function invocation
   */
  private async logInvocation(invocation: {
    function_id: string
    execution_time_ms: number
    memory_used_mb: number
    status: 'success' | 'error' | 'timeout'
    request_size_bytes: number
    response_size_bytes: number
    error_message?: string
    logs: string
    invoked_at: string
  }): Promise<void> {
    try {
      await safeDb.safeInsert(`
        INSERT INTO edge_function_invocations (
          function_id, execution_time_ms, memory_used_mb, status,
          request_size_bytes, response_size_bytes, error_message, logs, invoked_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        invocation.function_id,
        invocation.execution_time_ms,
        invocation.memory_used_mb,
        invocation.status,
        invocation.request_size_bytes,
        invocation.response_size_bytes,
        invocation.error_message,
        invocation.logs,
        invocation.invoked_at
      ])
    } catch (error) {
      console.error('Failed to log invocation:', error)
    }
  }

  /**
   * Get function metrics
   */
  async getFunctionMetrics(functionId: string, since?: Date): Promise<{
    totalInvocations: number
    successRate: number
    averageExecutionTime: number
    totalExecutionTime: number
    errorCount: number
    timeoutCount: number
  }> {
    let query = `
      SELECT 
        COUNT(*) as total_invocations,
        AVG(execution_time_ms) as avg_execution_time,
        SUM(execution_time_ms) as total_execution_time,
        COUNT(CASE WHEN status = 'success' THEN 1 END) as success_count,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
        COUNT(CASE WHEN status = 'timeout' THEN 1 END) as timeout_count
      FROM edge_function_invocations 
      WHERE function_id = $1
    `
    
    const params = [functionId]
    
    if (since) {
      query += ` AND invoked_at >= $2`
      params.push(since.toISOString())
    }

    const result = await safeDb.safeSelect(query, params)
    const row = result.rows[0]

    return {
      totalInvocations: parseInt(row.total_invocations),
      successRate: row.total_invocations > 0 
        ? (row.success_count / row.total_invocations) * 100 
        : 0,
      averageExecutionTime: parseFloat(row.avg_execution_time) || 0,
      totalExecutionTime: parseInt(row.total_execution_time) || 0,
      errorCount: parseInt(row.error_count),
      timeoutCount: parseInt(row.timeout_count)
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.poolCleanupInterval) {
      clearInterval(this.poolCleanupInterval)
    }

    // Remove all pooled containers
    for (const pool of this.containerPool.values()) {
      for (const entry of pool) {
        try {
          await entry.container.remove({ force: true })
        } catch {}
      }
    }

    this.containerPool.clear()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Export singleton instance
export const dockerEdgeFunctionRuntime = new DockerEdgeFunctionRuntime()

