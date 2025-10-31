import { neon } from "@neondatabase/serverless"

export interface SafeQueryOptions {
  timeout?: number // milliseconds, default 30 seconds
  maxRows?: number // maximum rows to return, default 10000
  allowDDL?: boolean // allow DDL operations, default false
  allowDML?: boolean // allow DML operations, default true for writes
  adminOverride?: boolean // bypass safety checks for admin operations
}

export interface QueryResult<T = any> {
  rows: T[]
  rowCount: number
  executionTime: number
  warnings?: string[]
}

export interface QueryMetrics {
  totalQueries: number
  averageExecutionTime: number
  slowQueries: number
  timeoutCount: number
  blockedQueries: number
}

// Dangerous SQL keywords and patterns
const DANGEROUS_PATTERNS = {
  // DDL Operations
  DDL_KEYWORDS: [
    'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME',
    'GRANT', 'REVOKE', 'COMMENT'
  ],
  
  // System/Admin functions
  DANGEROUS_FUNCTIONS: [
    'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
    'pg_rotate_logfile', 'pg_switch_wal', 'lo_import', 'lo_export',
    'copy', 'pg_read_file', 'pg_ls_dir', 'pg_stat_file'
  ],
  
  // Dangerous system tables/views
  SYSTEM_TABLES: [
    'pg_authid', 'pg_shadow', 'pg_user', 'pg_roles',
    'pg_database', 'pg_tablespace', 'pg_settings'
  ],
  
  // Injection patterns
  INJECTION_PATTERNS: [
    /;\s*(drop|delete|truncate|alter)\s+/i,
    /union\s+select/i,
    /\/\*[\s\S]*?\*\//g, // SQL comments
    /--[\s\S]*$/gm, // Single line comments
    /exec\s*\(/i,
    /execute\s*\(/i
  ]
}

class QueryMetricsCollector {
  private metrics: QueryMetrics = {
    totalQueries: 0,
    averageExecutionTime: 0,
    slowQueries: 0,
    timeoutCount: 0,
    blockedQueries: 0
  }

  private executionTimes: number[] = []

  recordQuery(executionTime: number, timedOut: boolean = false, blocked: boolean = false) {
    this.metrics.totalQueries++
    
    if (blocked) {
      this.metrics.blockedQueries++
      return
    }
    
    if (timedOut) {
      this.metrics.timeoutCount++
      return
    }

    this.executionTimes.push(executionTime)
    
    // Keep only last 1000 execution times
    if (this.executionTimes.length > 1000) {
      this.executionTimes.shift()
    }

    // Calculate average
    this.metrics.averageExecutionTime = 
      this.executionTimes.reduce((sum, time) => sum + time, 0) / this.executionTimes.length

    // Count slow queries (>5 seconds)
    if (executionTime > 5000) {
      this.metrics.slowQueries++
    }
  }

  getMetrics(): QueryMetrics {
    return { ...this.metrics }
  }

  reset() {
    this.metrics = {
      totalQueries: 0,
      averageExecutionTime: 0,
      slowQueries: 0,
      timeoutCount: 0,
      blockedQueries: 0
    }
    this.executionTimes = []
  }
}

export class SafeDatabase {
  private sql: any
  private metrics = new QueryMetricsCollector()
  private defaultTimeout: number

  constructor(connectionString: string, defaultTimeout: number = 30000) {
    this.sql = neon(connectionString)
    this.defaultTimeout = defaultTimeout
  }

  private analyzeQuery(query: string): {
    isDDL: boolean
    isDML: boolean
    isSelect: boolean
    hasDangerousPatterns: boolean
    warnings: string[]
  } {
    const normalizedQuery = query.trim().toUpperCase()
    const warnings: string[] = []

    // Check for DDL operations
    const isDDL = DANGEROUS_PATTERNS.DDL_KEYWORDS.some(keyword => 
      normalizedQuery.startsWith(keyword)
    )

    // Check for DML operations
    const isDML = /^(INSERT|UPDATE|DELETE|MERGE|REPLACE)/i.test(normalizedQuery)
    const isSelect = /^SELECT/i.test(normalizedQuery)

    // Check for dangerous functions
    const hasDangerousFunctions = DANGEROUS_PATTERNS.DANGEROUS_FUNCTIONS.some(func =>
      normalizedQuery.includes(func.toUpperCase())
    )

    // Check for system table access
    const hasSystemTables = DANGEROUS_PATTERNS.SYSTEM_TABLES.some(table =>
      normalizedQuery.includes(table.toUpperCase())
    )

    // Check for injection patterns
    const hasInjectionPatterns = DANGEROUS_PATTERNS.INJECTION_PATTERNS.some(pattern =>
      pattern.test(query)
    )

    const hasDangerousPatterns = hasDangerousFunctions || hasSystemTables || hasInjectionPatterns

    if (hasDangerousFunctions) {
      warnings.push("Query contains potentially dangerous system functions")
    }
    
    if (hasSystemTables) {
      warnings.push("Query accesses system tables")
    }
    
    if (hasInjectionPatterns) {
      warnings.push("Query contains patterns that may indicate SQL injection")
    }

    return {
      isDDL,
      isDML,
      isSelect,
      hasDangerousPatterns,
      warnings
    }
  }

  private validateQuery(query: string, options: SafeQueryOptions = {}): {
    allowed: boolean
    errors: string[]
    warnings: string[]
  } {
    const errors: string[] = []
    const analysis = this.analyzeQuery(query)

    // Admin override bypasses all checks
    if (options.adminOverride) {
      return { allowed: true, errors: [], warnings: analysis.warnings }
    }

    // Block dangerous patterns unless explicitly allowed
    if (analysis.hasDangerousPatterns) {
      errors.push("Query contains dangerous patterns and is not allowed")
    }

    // Check DDL permissions
    if (analysis.isDDL && !options.allowDDL) {
      errors.push("DDL operations are not allowed without explicit permission")
    }

    // Check DML permissions for non-SELECT operations
    if (analysis.isDML && !options.allowDML) {
      errors.push("DML operations are not allowed")
    }

    // Check for required parameterization
    if (this.requiresParameterization(query)) {
      errors.push("Query appears to contain user input and must use parameterized queries")
    }

    return {
      allowed: errors.length === 0,
      errors,
      warnings: analysis.warnings
    }
  }

  private requiresParameterization(query: string): boolean {
    // Check for potential user input that should be parameterized
    const suspiciousPatterns = [
      /'\s*\+\s*\w+/i, // String concatenation
      /"\s*\+\s*\w+/i,
      /=\s*['"][^'"]*\$\{/i, // Template literal injection
      /=\s*['"][^'"]*%s/i, // Printf-style formatting
      /=\s*['"][^'"]*\+/i, // String concatenation in WHERE clauses
    ]

    return suspiciousPatterns.some(pattern => pattern.test(query))
  }

  private async executeWithTimeout<T>(
    queryPromise: Promise<T>, 
    timeoutMs: number
  ): Promise<{ result?: T; timedOut: boolean }> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Query timeout')), timeoutMs)
    })

    try {
      const result = await Promise.race([queryPromise, timeoutPromise])
      return { result, timedOut: false }
    } catch (error) {
      if (error instanceof Error && error.message === 'Query timeout') {
        return { timedOut: true }
      }
      throw error
    }
  }

  async query<T = any>(
    query: string, 
    params: any[] = [], 
    options: SafeQueryOptions = {}
  ): Promise<QueryResult<T>> {
    const startTime = Date.now()
    const timeout = options.timeout || this.defaultTimeout
    const maxRows = options.maxRows || 10000

    try {
      // Validate query safety
      const validation = this.validateQuery(query, options)
      
      if (!validation.allowed) {
        this.metrics.recordQuery(0, false, true)
        throw new Error(`Query blocked: ${validation.errors.join(', ')}`)
      }

      // Execute query with timeout
      const queryPromise = params.length > 0 
        ? this.sql(query, params)
        : this.sql.unsafe(query)

      const { result, timedOut } = await this.executeWithTimeout(queryPromise, timeout)
      const executionTime = Date.now() - startTime

      if (timedOut) {
        this.metrics.recordQuery(executionTime, true)
        throw new Error(`Query timed out after ${timeout}ms`)
      }

      if (!result) {
        throw new Error('Query returned no result')
      }

      // Limit result set size
      const rows = Array.isArray(result) ? result.slice(0, maxRows) : [result]
      const rowCount = Array.isArray(result) ? result.length : 1

      this.metrics.recordQuery(executionTime)

      const queryResult: QueryResult<T> = {
        rows: rows as T[],
        rowCount,
        executionTime,
      }

      if (validation.warnings.length > 0) {
        queryResult.warnings = validation.warnings
      }

      if (rowCount > maxRows) {
        queryResult.warnings = [
          ...(queryResult.warnings || []),
          `Result set truncated to ${maxRows} rows`
        ]
      }

      return queryResult

    } catch (error) {
      const executionTime = Date.now() - startTime
      this.metrics.recordQuery(executionTime, false, false)
      throw error
    }
  }

  async safeSelect<T = any>(
    query: string, 
    params: any[] = [], 
    options: Omit<SafeQueryOptions, 'allowDDL' | 'allowDML'> = {}
  ): Promise<QueryResult<T>> {
    return this.query<T>(query, params, {
      ...options,
      allowDDL: false,
      allowDML: false,
    })
  }

  async safeInsert<T = any>(
    query: string, 
    params: any[] = [], 
    options: Omit<SafeQueryOptions, 'allowDDL'> = {}
  ): Promise<QueryResult<T>> {
    return this.query<T>(query, params, {
      ...options,
      allowDDL: false,
      allowDML: true,
    })
  }

  async safeUpdate<T = any>(
    query: string, 
    params: any[] = [], 
    options: Omit<SafeQueryOptions, 'allowDDL'> = {}
  ): Promise<QueryResult<T>> {
    return this.query<T>(query, params, {
      ...options,
      allowDDL: false,
      allowDML: true,
    })
  }

  async safeDelete<T = any>(
    query: string, 
    params: any[] = [], 
    options: Omit<SafeQueryOptions, 'allowDDL'> = {}
  ): Promise<QueryResult<T>> {
    return this.query<T>(query, params, {
      ...options,
      allowDDL: false,
      allowDML: true,
    })
  }

  async adminQuery<T = any>(
    query: string, 
    params: any[] = [], 
    options: SafeQueryOptions = {}
  ): Promise<QueryResult<T>> {
    return this.query<T>(query, params, {
      ...options,
      adminOverride: true,
    })
  }

  getMetrics(): QueryMetrics {
    return this.metrics.getMetrics()
  }

  resetMetrics(): void {
    this.metrics.reset()
  }

  // Helper method to explain query execution plan
  async explainQuery(query: string, params: any[] = []): Promise<QueryResult> {
    const explainQuery = `EXPLAIN (ANALYZE true, BUFFERS true, FORMAT JSON) ${query}`
    return this.query(explainQuery, params, { 
      adminOverride: true,
      timeout: 60000 // 1 minute for EXPLAIN
    })
  }

  // Transaction support with safety measures
  async transaction<T>(
    callback: (db: SafeDatabase) => Promise<T>,
    options: SafeQueryOptions = {}
  ): Promise<T> {
    await this.query('BEGIN', [], options)
    
    try {
      const result = await callback(this)
      await this.query('COMMIT', [], options)
      return result
    } catch (error) {
      await this.query('ROLLBACK', [], options)
      throw error
    }
  }
}

// Default instance
export const safeDb = new SafeDatabase(process.env.DATABASE_URL!)

// Query builder for common operations
export class SafeQueryBuilder {
  private safeDb: SafeDatabase

  constructor(db: SafeDatabase) {
    this.safeDb = db
  }

  select(table: string, columns: string[] = ['*']) {
    return new SelectQueryBuilder(this.safeDb, table, columns)
  }

  insert(table: string, data: Record<string, any>) {
    return new InsertQueryBuilder(this.safeDb, table, data)
  }

  update(table: string, data: Record<string, any>) {
    return new UpdateQueryBuilder(this.safeDb, table, data)
  }

  delete(table: string) {
    return new DeleteQueryBuilder(this.safeDb, table)
  }
}

class SelectQueryBuilder {
  private db: SafeDatabase
  private table: string
  private columns: string[]
  private whereConditions: string[] = []
  private params: any[] = []
  private orderByClause?: string
  private limitClause?: number
  private offsetClause?: number

  constructor(db: SafeDatabase, table: string, columns: string[]) {
    this.db = db
    this.table = table
    this.columns = columns
  }

  where(condition: string, ...params: any[]) {
    this.whereConditions.push(condition)
    this.params.push(...params)
    return this
  }

  orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC') {
    this.orderByClause = `${column} ${direction}`
    return this
  }

  limit(count: number) {
    this.limitClause = count
    return this
  }

  offset(count: number) {
    this.offsetClause = count
    return this
  }

  async execute<T = any>(): Promise<QueryResult<T>> {
    let query = `SELECT ${this.columns.join(', ')} FROM ${this.table}`
    
    if (this.whereConditions.length > 0) {
      query += ` WHERE ${this.whereConditions.join(' AND ')}`
    }
    
    if (this.orderByClause) {
      query += ` ORDER BY ${this.orderByClause}`
    }
    
    if (this.limitClause) {
      query += ` LIMIT ${this.limitClause}`
    }
    
    if (this.offsetClause) {
      query += ` OFFSET ${this.offsetClause}`
    }

    return this.db.safeSelect<T>(query, this.params)
  }
}

class InsertQueryBuilder {
  private db: SafeDatabase
  private table: string
  private data: Record<string, any>
  private returningClause: string[] = []

  constructor(db: SafeDatabase, table: string, data: Record<string, any>) {
    this.db = db
    this.table = table
    this.data = data
  }

  returning(columns: string[]) {
    this.returningClause = columns
    return this
  }

  async execute<T = any>(): Promise<QueryResult<T>> {
    const columns = Object.keys(this.data)
    const placeholders = columns.map((_, i) => `$${i + 1}`)
    const values = Object.values(this.data)

    let query = `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
    
    if (this.returningClause.length > 0) {
      query += ` RETURNING ${this.returningClause.join(', ')}`
    }

    return this.db.safeInsert<T>(query, values)
  }
}

class UpdateQueryBuilder {
  private db: SafeDatabase
  private table: string
  private data: Record<string, any>
  private whereConditions: string[] = []
  private params: any[] = []
  private returningClause: string[] = []

  constructor(db: SafeDatabase, table: string, data: Record<string, any>) {
    this.db = db
    this.table = table
    this.data = data
    this.params = Object.values(data)
  }

  where(condition: string, ...params: any[]) {
    this.whereConditions.push(condition)
    this.params.push(...params)
    return this
  }

  returning(columns: string[]) {
    this.returningClause = columns
    return this
  }

  async execute<T = any>(): Promise<QueryResult<T>> {
    const columns = Object.keys(this.data)
    const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ')

    let query = `UPDATE ${this.table} SET ${setClause}`
    
    if (this.whereConditions.length > 0) {
      const whereParamStart = columns.length + 1
      const adjustedConditions = this.whereConditions.map(condition => {
        return condition.replace(/\$(\d+)/g, (match, num) => {
          return `$${parseInt(num) + columns.length}`
        })
      })
      query += ` WHERE ${adjustedConditions.join(' AND ')}`
    }
    
    if (this.returningClause.length > 0) {
      query += ` RETURNING ${this.returningClause.join(', ')}`
    }

    return this.db.safeUpdate<T>(query, this.params)
  }
}

class DeleteQueryBuilder {
  private db: SafeDatabase
  private table: string
  private whereConditions: string[] = []
  private params: any[] = []
  private returningClause: string[] = []

  constructor(db: SafeDatabase, table: string) {
    this.db = db
    this.table = table
  }

  where(condition: string, ...params: any[]) {
    this.whereConditions.push(condition)
    this.params.push(...params)
    return this
  }

  returning(columns: string[]) {
    this.returningClause = columns
    return this
  }

  async execute<T = any>(): Promise<QueryResult<T>> {
    if (this.whereConditions.length === 0) {
      throw new Error('DELETE queries must include WHERE conditions for safety')
    }

    let query = `DELETE FROM ${this.table} WHERE ${this.whereConditions.join(' AND ')}`
    
    if (this.returningClause.length > 0) {
      query += ` RETURNING ${this.returningClause.join(', ')}`
    }

    return this.db.safeDelete<T>(query, this.params)
  }
}

export const queryBuilder = new SafeQueryBuilder(safeDb)