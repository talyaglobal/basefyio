import { neon } from "@neondatabase/serverless"
import { ConnectionPool, PoolConfig } from "./connection-pool"
import { SafeDatabase } from "./db-safety"

/**
 * Dynamic Connection Manager
 * Manages database connections for different databases based on database ID
 */
export class DynamicConnectionManager {
  private static instance: DynamicConnectionManager
  private connectionPools: Map<string, ConnectionPool> = new Map()
  private safeDatabases: Map<string, SafeDatabase> = new Map()
  private databaseMetadata: Map<string, { url: string; provider: string; createdAt: Date }> = new Map()
  private defaultUrl: string
  private defaultProvider: string

  private constructor() {
    this.defaultUrl = process.env.DATABASE_URL!
    this.defaultProvider = (process.env.DB_PROVIDER as any) || 'neon'
  }

  static getInstance(): DynamicConnectionManager {
    if (!DynamicConnectionManager.instance) {
      DynamicConnectionManager.instance = new DynamicConnectionManager()
    }
    return DynamicConnectionManager.instance
  }

  /**
   * Register or update a database connection
   */
  async registerDatabase(
    databaseId: string,
    databaseUrl: string,
    provider: 'neon' | 'postgres' = 'neon'
  ): Promise<void> {
    // Check if we already have this database registered
    if (this.databaseMetadata.has(databaseId)) {
      const existing = this.databaseMetadata.get(databaseId)!
      
      // Only recreate if URL or provider has changed
      if (existing.url !== databaseUrl || existing.provider !== provider) {
        await this.deregisterDatabase(databaseId)
      } else {
        // Already registered with same details, skip
        return
      }
    }

    // Store metadata
    this.databaseMetadata.set(databaseId, {
      url: databaseUrl,
      provider,
      createdAt: new Date(),
    })

    // Create connection pool for this database
    const poolConfig: PoolConfig = {
      provider,
      connectionUrl: databaseUrl,
      maxConnections: parseInt(process.env.DB_POOL_MAX || '20'),
      minConnections: parseInt(process.env.DB_POOL_MIN || '5'),
      idleTimeout: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '300000'), // 5 minutes
      connectionTimeout: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT || '30000'), // 30 seconds
      retryAttempts: parseInt(process.env.DB_POOL_RETRY_ATTEMPTS || '3'),
      enableReadReplicas: process.env.DB_ENABLE_READ_REPLICAS === 'true',
      readReplicaUrls: process.env.DB_READ_REPLICA_URLS?.split(','),
    }

    const pool = new ConnectionPool(poolConfig)
    this.connectionPools.set(databaseId, pool)

    // Create SafeDatabase instance for this database
    const safeDb = new SafeDatabase(databaseUrl)
    this.safeDatabases.set(databaseId, safeDb)

    console.log(`Registered database ${databaseId} with provider ${provider}`)
  }

  /**
   * Deregister a database connection
   */
  async deregisterDatabase(databaseId: string): Promise<void> {
    const pool = this.connectionPools.get(databaseId)
    if (pool) {
      await pool.close()
      this.connectionPools.delete(databaseId)
    }

    this.safeDatabases.delete(databaseId)
    this.databaseMetadata.delete(databaseId)

    console.log(`Deregistered database ${databaseId}`)
  }

  /**
   * Get connection pool for a specific database
   * Falls back to default if databaseId is not provided or not found
   */
  getConnectionPool(databaseId?: string | null): ConnectionPool {
    if (!databaseId) {
      return this.getDefaultConnectionPool()
    }

    const pool = this.connectionPools.get(databaseId)
    if (!pool) {
      console.warn(`Connection pool not found for database ${databaseId}, using default`)
      return this.getDefaultConnectionPool()
    }

    return pool
  }

  /**
   * Get SafeDatabase instance for a specific database
   * Falls back to default if databaseId is not provided or not found
   */
  getSafeDatabase(databaseId?: string | null): SafeDatabase {
    if (!databaseId) {
      return this.getDefaultSafeDatabase()
    }

    const safeDb = this.safeDatabases.get(databaseId)
    if (!safeDb) {
      console.warn(`SafeDatabase not found for database ${databaseId}, using default`)
      return this.getDefaultSafeDatabase()
    }

    return safeDb
  }

  /**
   * Get or create default connection pool
   */
  private getDefaultConnectionPool(): ConnectionPool {
    const defaultId = 'default'
    
    if (!this.connectionPools.has(defaultId)) {
      const poolConfig: PoolConfig = {
        provider: this.defaultProvider as any,
        connectionUrl: this.defaultUrl,
        maxConnections: parseInt(process.env.DB_POOL_MAX || '20'),
        minConnections: parseInt(process.env.DB_POOL_MIN || '5'),
        idleTimeout: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '300000'),
        connectionTimeout: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT || '30000'),
        retryAttempts: parseInt(process.env.DB_POOL_RETRY_ATTEMPTS || '3'),
        enableReadReplicas: process.env.DB_ENABLE_READ_REPLICAS === 'true',
        readReplicaUrls: process.env.DB_READ_REPLICA_URLS?.split(','),
      }

      const pool = new ConnectionPool(poolConfig)
      this.connectionPools.set(defaultId, pool)
    }

    return this.connectionPools.get(defaultId)!
  }

  /**
   * Get or create default SafeDatabase
   */
  private getDefaultSafeDatabase(): SafeDatabase {
    const defaultId = 'default'
    
    if (!this.safeDatabases.has(defaultId)) {
      const safeDb = new SafeDatabase(this.defaultUrl)
      this.safeDatabases.set(defaultId, safeDb)
    }

    return this.safeDatabases.get(defaultId)!
  }

  /**
   * Get direct SQL client for a specific database (for backward compatibility)
   */
  getSQL(databaseId?: string | null): any {
    if (!databaseId) {
      return neon(this.defaultUrl)
    }

    const metadata = this.databaseMetadata.get(databaseId)
    if (!metadata) {
      console.warn(`Database metadata not found for ${databaseId}, using default`)
      return neon(this.defaultUrl)
    }

    return neon(metadata.url)
  }

  /**
   * Check if a database is registered
   */
  isRegistered(databaseId: string): boolean {
    return this.databaseMetadata.has(databaseId)
  }

  /**
   * Get all registered database IDs
   */
  getRegisteredDatabases(): string[] {
    return Array.from(this.databaseMetadata.keys())
  }

  /**
   * Cleanup all connections
   */
  async cleanup(): Promise<void> {
    const pools = Array.from(this.connectionPools.values())
    await Promise.all(pools.map(pool => pool.close()))
    
    this.connectionPools.clear()
    this.safeDatabases.clear()
    this.databaseMetadata.clear()

    console.log('All database connections cleaned up')
  }

  /**
   * Get statistics for all managed connections
   */
  getStats(): Record<string, any> {
    const stats: Record<string, any> = {}

    for (const [databaseId, pool] of this.connectionPools.entries()) {
      stats[databaseId] = {
        poolStats: pool.getStats(),
        connectionDetails: pool.getConnectionDetails(),
      }
    }

    return stats
  }
}

// Export singleton instance
export const dynamicConnectionManager = DynamicConnectionManager.getInstance()

