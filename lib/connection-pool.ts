import { neon } from "@neondatabase/serverless"

export interface PoolConfig {
  provider: 'neon' | 'postgres'
  connectionUrl: string
  maxConnections: number
  minConnections: number
  idleTimeout: number // milliseconds
  connectionTimeout: number // milliseconds
  retryAttempts: number
  enableReadReplicas: boolean
  readReplicaUrls?: string[]
}

export interface PoolStats {
  total: number
  active: number
  idle: number
  waiting: number
  errors: number
  created: number
  destroyed: number
  avgConnectionTime: number
  avgQueryTime: number
}

export interface Connection {
  id: string
  sql: any
  client?: any
  createdAt: Date
  lastUsed: Date
  inUse: boolean
  queries: number
  errors: number
}

export class ConnectionPool {
  private config: PoolConfig
  private connections: Map<string, Connection> = new Map()
  private readConnections: Map<string, Connection> = new Map()
  private waitingQueue: Array<(connection: Connection) => void> = []
  private stats: PoolStats = {
    total: 0,
    active: 0,
    idle: 0,
    waiting: 0,
    errors: 0,
    created: 0,
    destroyed: 0,
    avgConnectionTime: 0,
    avgQueryTime: 0,
  }

  constructor(config: PoolConfig) {
    this.config = config
    this.initialize()
  }

  private async initialize() {
    // Create minimum number of connections
    for (let i = 0; i < this.config.minConnections; i++) {
      await this.createConnection()
    }

    // Create read replica connections if enabled
    if (this.config.enableReadReplicas && this.config.readReplicaUrls) {
      for (const replicaUrl of this.config.readReplicaUrls) {
        await this.createReadConnection(replicaUrl)
      }
    }

    // Setup cleanup interval
    setInterval(() => {
      this.cleanup()
    }, 30000) // Clean up every 30 seconds
  }

  private async createConnection(isReadReplica: boolean = false, replicaUrl?: string): Promise<Connection> {
    const id = `conn_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const connectionUrl = replicaUrl || this.config.connectionUrl
    const createdAt = new Date()

    let sql: any
    let client: any

    try {
      switch (this.config.provider) {
        case 'neon':
        case 'postgres':
          // Neon doesn't support maxConnections option
          sql = neon(connectionUrl)
          break
        
        default:
          throw new Error(`Unsupported provider: ${this.config.provider}`)
      }

      const connection: Connection = {
        id,
        sql,
        client,
        createdAt,
        lastUsed: createdAt,
        inUse: false,
        queries: 0,
        errors: 0,
      }

      if (isReadReplica) {
        this.readConnections.set(id, connection)
      } else {
        this.connections.set(id, connection)
      }

      this.stats.created++
      this.stats.total++
      this.stats.idle++

      return connection
    } catch (error) {
      this.stats.errors++
      console.error('Failed to create database connection:', error)
      throw error
    }
  }

  private async createReadConnection(replicaUrl: string): Promise<Connection> {
    return this.createConnection(true, replicaUrl)
  }

  async getConnection(preferReadReplica: boolean = false): Promise<Connection> {
    const startTime = Date.now()

    // Try to get read replica connection if requested and available
    if (preferReadReplica && this.readConnections.size > 0) {
      for (const connection of this.readConnections.values()) {
        if (!connection.inUse) {
          connection.inUse = true
          connection.lastUsed = new Date()
          this.stats.idle--
          this.stats.active++
          return connection
        }
      }
    }

    // Try to get available connection
    for (const connection of this.connections.values()) {
      if (!connection.inUse) {
        connection.inUse = true
        connection.lastUsed = new Date()
        this.stats.idle--
        this.stats.active++
        this.updateAvgConnectionTime(Date.now() - startTime)
        return connection
      }
    }

    // If we can create more connections, create one
    if (this.connections.size < this.config.maxConnections) {
      const connection = await this.createConnection()
      connection.inUse = true
      connection.lastUsed = new Date()
      this.stats.idle--
      this.stats.active++
      this.updateAvgConnectionTime(Date.now() - startTime)
      return connection
    }

    // Wait for a connection to become available
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waitingQueue.indexOf(resolve)
        if (index !== -1) {
          this.waitingQueue.splice(index, 1)
          this.stats.waiting--
        }
        reject(new Error('Connection timeout'))
      }, this.config.connectionTimeout)

      this.waitingQueue.push((connection) => {
        clearTimeout(timeout)
        this.updateAvgConnectionTime(Date.now() - startTime)
        resolve(connection)
      })
      this.stats.waiting++
    })
  }

  releaseConnection(connectionId: string) {
    const connection = this.connections.get(connectionId) || this.readConnections.get(connectionId)
    
    if (connection && connection.inUse) {
      connection.inUse = false
      connection.lastUsed = new Date()
      this.stats.active--
      this.stats.idle++

      // If there are waiting requests, fulfill the next one
      if (this.waitingQueue.length > 0) {
        const nextResolve = this.waitingQueue.shift()
        if (nextResolve) {
          connection.inUse = true
          this.stats.idle--
          this.stats.active++
          this.stats.waiting--
          nextResolve(connection)
        }
      }
    }
  }

  async query<T = any>(
    query: string, 
    params: any[] = [], 
    options: { 
      preferReadReplica?: boolean,
      timeout?: number 
    } = {}
  ): Promise<T[]> {
    const startTime = Date.now()
    let connection: Connection | null = null

    try {
      connection = await this.getConnection(options.preferReadReplica)
      connection.queries++

      let result: any

      // For Neon/PostgreSQL
      if (params.length > 0) {
        result = await connection.sql.query(query, params)
      } else {
        result = await connection.sql.unsafe(query)
      }
      
      return Array.isArray(result) ? result : [result]
    } catch (error) {
      if (connection) {
        connection.errors++
      }
      this.stats.errors++
      console.error('Database query error:', error)
      throw error
    } finally {
      if (connection) {
        this.releaseConnection(connection.id)
        this.updateAvgQueryTime(Date.now() - startTime)
      }
    }
  }

  async execute<T = any>(
    callback: (sql: any) => Promise<T>,
    options: { 
      preferReadReplica?: boolean,
      timeout?: number 
    } = {}
  ): Promise<T> {
    const startTime = Date.now()
    let connection: Connection | null = null

    try {
      connection = await this.getConnection(options.preferReadReplica)
      connection.queries++

      const result = await callback(connection.sql)
      
      return result
    } catch (error) {
      if (connection) {
        connection.errors++
      }
      this.stats.errors++
      console.error('Database execution error:', error)
      throw error
    } finally {
      if (connection) {
        this.releaseConnection(connection.id)
        this.updateAvgQueryTime(Date.now() - startTime)
      }
    }
  }

  private cleanup() {
    const now = Date.now()
    const idleTimeout = this.config.idleTimeout

    // Clean up idle connections (but keep minimum)
    for (const [id, connection] of this.connections.entries()) {
      if (!connection.inUse && 
          (now - connection.lastUsed.getTime()) > idleTimeout &&
          this.connections.size > this.config.minConnections) {
        
        this.connections.delete(id)
        this.stats.destroyed++
        this.stats.total--
        this.stats.idle--
      }
    }

    // Clean up read replica connections
    for (const [id, connection] of this.readConnections.entries()) {
      if (!connection.inUse && 
          (now - connection.lastUsed.getTime()) > idleTimeout) {
        
        this.readConnections.delete(id)
        this.stats.destroyed++
        this.stats.total--
        this.stats.idle--
      }
    }
  }

  private updateAvgConnectionTime(time: number) {
    this.stats.avgConnectionTime = (this.stats.avgConnectionTime + time) / 2
  }

  private updateAvgQueryTime(time: number) {
    this.stats.avgQueryTime = (this.stats.avgQueryTime + time) / 2
  }

  getStats(): PoolStats {
    return { ...this.stats }
  }

  getConnectionDetails() {
    const allConnections = [...this.connections.values(), ...this.readConnections.values()]
    
    return allConnections.map(conn => ({
      id: conn.id,
      createdAt: conn.createdAt,
      lastUsed: conn.lastUsed,
      inUse: conn.inUse,
      queries: conn.queries,
      errors: conn.errors,
      isReadReplica: this.readConnections.has(conn.id),
    }))
  }

  async close() {
    // Clear all connections
    for (const connection of this.connections.values()) {
      if (connection.client && typeof connection.client.close === 'function') {
        await connection.client.close()
      }
    }

    for (const connection of this.readConnections.values()) {
      if (connection.client && typeof connection.client.close === 'function') {
        await connection.client.close()
      }
    }

    this.connections.clear()
    this.readConnections.clear()
    
    // Reject any waiting connections
    this.waitingQueue.forEach(resolve => {
      // This will cause an error, but prevents hanging
    })
    this.waitingQueue.length = 0
  }
}

// Default connection pool
export const connectionPool = new ConnectionPool({
  provider: (process.env.DB_PROVIDER as any) || 'neon',
  connectionUrl: process.env.DATABASE_URL!,
  maxConnections: parseInt(process.env.DB_POOL_MAX || '20'),
  minConnections: parseInt(process.env.DB_POOL_MIN || '5'),
  idleTimeout: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '300000'), // 5 minutes
  connectionTimeout: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT || '30000'), // 30 seconds
  retryAttempts: parseInt(process.env.DB_POOL_RETRY_ATTEMPTS || '3'),
  enableReadReplicas: process.env.DB_ENABLE_READ_REPLICAS === 'true',
  readReplicaUrls: process.env.DB_READ_REPLICA_URLS?.split(','),
})