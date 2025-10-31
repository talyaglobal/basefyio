// Edge Runtime compatible imports
import { safeDb } from './db-safety'

// Type definitions for Node.js modules (not imported statically to avoid bundling issues)
type SpawnFunction = typeof import('child_process').spawn
type ChildProcessType = import('child_process').ChildProcess
type FSPromises = typeof import('fs').promises
type PathJoin = typeof import('path').join

// Lazy load Node.js modules to avoid bundling issues
async function getNodeModules() {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error('Node.js runtime required')
  }
  
  const [childProcess, fsModule, pathModule] = await Promise.all([
    import('child_process'),
    import('fs'),
    import('path')
  ])
  
  return {
    spawn: childProcess.spawn as SpawnFunction,
    fs: fsModule.promises as FSPromises,
    join: pathModule.join as PathJoin,
    ChildProcess: childProcess.ChildProcess as typeof import('child_process').ChildProcess
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
  is_active: boolean
  version: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface FunctionInvocation {
  id: string
  function_id: string
  execution_time_ms: number
  memory_used_mb: number
  status: 'success' | 'error' | 'timeout'
  request_size_bytes: number
  response_size_bytes: number
  error_message?: string
  logs: string
  invoked_at: string
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

export class EdgeFunctionRuntime {
  private tempDir: string = ''
  private processes: Map<string, ChildProcessType> = new Map()
  private nodeModules: Awaited<ReturnType<typeof getNodeModules>> | null = null

  constructor() {
    // Initialize tempDir lazily after Node modules are loaded
    this.initializeTempDir()
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

  async deployFunction(func: EdgeFunction): Promise<void> {
    if (!this.nodeModules) {
      await this.initializeTempDir()
    }
    const modules = this.nodeModules!
    
    const functionDir = modules.join(this.tempDir, func.slug)
    await modules.fs.mkdir(functionDir, { recursive: true })

    // Write function source code
    const sourceFile = func.runtime === 'deno' ? 'index.ts' : 'index.js'
    await modules.fs.writeFile(modules.join(functionDir, sourceFile), func.source_code)

    // Create environment file
    const envContent = Object.entries(func.environment_variables)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    
    await modules.fs.writeFile(modules.join(functionDir, '.env'), envContent)

    // Update deployment timestamp
    await safeDb.safeUpdate(`
      UPDATE edge_functions 
      SET deployed_at = NOW() 
      WHERE id = $1
    `, [func.id])

    console.log(`📦 Function ${func.slug} deployed`)
  }

  async invokeFunction(
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
      const result = await this.executeFunction(func, context)
      const executionTime = Date.now() - startTime

      // Log invocation
      await this.logInvocation({
        function_id: func.id,
        execution_time_ms: executionTime,
        memory_used_mb: memoryUsed,
        status: 'success',
        request_size_bytes: JSON.stringify(context.request).length,
        response_size_bytes: JSON.stringify(result).length,
        logs,
        invoked_at: new Date().toISOString()
      })

      return {
        success: true,
        result,
        logs,
        executionTime,
        memoryUsed
      }

    } catch (error: any) {
      const executionTime = Date.now() - startTime
      
      // Log failed invocation
      await this.logInvocation({
        function_id: func.id,
        execution_time_ms: executionTime,
        memory_used_mb: memoryUsed,
        status: 'error',
        request_size_bytes: JSON.stringify(context.request).length,
        response_size_bytes: 0,
        error_message: error.message,
        logs,
        invoked_at: new Date().toISOString()
      })

      return {
        success: false,
        error: error.message,
        logs,
        executionTime,
        memoryUsed
      }
    }
  }

  private async executeFunction(func: EdgeFunction, context: InvocationContext): Promise<any> {
    if (!this.nodeModules) {
      await this.initializeTempDir()
    }
    const modules = this.nodeModules!
    
    return new Promise((resolve, reject) => {
      const functionDir = modules.join(this.tempDir, func.slug)
      let process: ChildProcessType | null = null
      
      const timeout = setTimeout(() => {
        if (process) {
          process.kill()
        }
        reject(new Error('Function execution timeout'))
      }, func.timeout_ms)

      let output = ''
      let errorOutput = ''

      // Prepare execution command
      let command: string
      let args: string[]

      if (func.runtime === 'deno') {
        command = 'deno'
        args = ['run', '--allow-all', modules.join(functionDir, 'index.ts')]
      } else {
        command = 'node'
        args = [modules.join(functionDir, 'index.js')]
      }

      // Execute function
      process = modules.spawn(command, args, {
        cwd: functionDir,
        env: {
          ...(typeof globalThis.process !== 'undefined' ? globalThis.process.env : {}),
          ...func.environment_variables,
          KOLAYBASE_CONTEXT: JSON.stringify(context)
        } as any
      })

      process.stdout?.on('data', (data) => {
        output += data.toString()
      })

      process.stderr?.on('data', (data) => {
        errorOutput += data.toString()
      })

      process.on('close', (code) => {
        clearTimeout(timeout)
        
        if (code === 0) {
          try {
            // Try to parse output as JSON
            const result = JSON.parse(output)
            resolve(result)
          } catch {
            // If not JSON, return as string
            resolve({ output })
          }
        } else {
          reject(new Error(`Function exited with code ${code}: ${errorOutput}`))
        }
      })

      process.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  }

  private async logInvocation(invocation: Omit<FunctionInvocation, 'id'>): Promise<void> {
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

  async getFunctionLogs(functionId: string, limit: number = 100): Promise<FunctionInvocation[]> {
    const result = await safeDb.safeSelect(`
      SELECT * FROM edge_function_invocations 
      WHERE function_id = $1 
      ORDER BY invoked_at DESC 
      LIMIT $2
    `, [functionId, limit])

    return result.rows
  }

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

  cleanup() {
    // Kill any running processes
    for (const [id, process] of this.processes) {
      process.kill()
      this.processes.delete(id)
    }
  }
}

export const edgeFunctionRuntime = new EdgeFunctionRuntime()

// Template functions for different use cases
export const FUNCTION_TEMPLATES = {
  'hello-world': {
    name: 'Hello World',
    description: 'A simple hello world function',
    runtime: 'deno' as const,
    source_code: `
export default async function handler(context: any) {
  const { request } = context;
  
  return new Response(JSON.stringify({
    message: "Hello from Kolaybase Edge Functions!",
    timestamp: new Date().toISOString(),
    method: request.method,
    url: request.url
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
    `.trim()
  },

  'webhook-processor': {
    name: 'Webhook Processor',
    description: 'Process incoming webhooks with validation',
    runtime: 'deno' as const,
    source_code: `
export default async function handler(context: any) {
  const { request, secrets } = context;
  
  // Validate webhook signature if secret is provided
  if (secrets.WEBHOOK_SECRET) {
    const signature = request.headers['x-webhook-signature'];
    // Add signature validation logic here
  }
  
  const payload = await request.json();
  
  // Process the webhook payload
  console.log('Processing webhook:', payload);
  
  // You can make database queries, call external APIs, etc.
  
  return new Response(JSON.stringify({
    success: true,
    processed_at: new Date().toISOString(),
    payload_size: JSON.stringify(payload).length
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
    `.trim()
  },

  'data-processor': {
    name: 'Data Processor',
    description: 'Process and transform data with database access',
    runtime: 'deno' as const,
    source_code: `
import { neon } from '@neondatabase/serverless';

export default async function handler(context: any) {
  const { request, environment } = context;
  
  // Initialize database connection
  const sql = neon(environment.DATABASE_URL);
  
  const payload = await request.json();
  
  try {
    // Process data and update database
    const result = await sql\`
      INSERT INTO processed_data (data, processed_at)
      VALUES (\${JSON.stringify(payload)}, NOW())
      RETURNING id
    \`;
    
    return new Response(JSON.stringify({
      success: true,
      id: result[0].id,
      message: 'Data processed successfully'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Processing error:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
    `.trim()
  }
};