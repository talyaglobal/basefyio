import { safeDb } from './db-safety'
import { dbManager } from './database-manager'

export interface ResourceQuota {
  userId: string
  database: {
    maxSize: number // bytes
    maxTables: number
    maxConnections: number
    maxQueryTime: number // milliseconds
  }
  storage: {
    maxSize: number // bytes
    maxFiles: number
    maxFileSize: number // bytes
  }
  api: {
    maxRequestsPerHour: number
    maxRequestsPerDay: number
    maxConcurrentRequests: number
  }
  backup: {
    maxBackups: number
    maxBackupSize: number // bytes
    retentionDays: number
  }
  features: {
    enableReplicas: boolean
    enablePITR: boolean
    enableWebhooks: boolean
    enableMigrations: boolean
  }
}

export interface ResourceUsage {
  userId: string
  timestamp: Date
  database: {
    size: number
    tables: number
    connections: number
    queryCount: number
    averageQueryTime: number
  }
  storage: {
    size: number
    files: number
    largestFile: number
  }
  api: {
    requestsLastHour: number
    requestsToday: number
    concurrentRequests: number
  }
  backup: {
    count: number
    totalSize: number
    oldestBackup: Date | null
  }
}

export const DEFAULT_QUOTAS: Record<string, ResourceQuota> = {
  free: {
    userId: '',
    database: {
      maxSize: 512 * 1024 * 1024, // 512MB
      maxTables: 10,
      maxConnections: 5,
      maxQueryTime: 30000, // 30 seconds
    },
    storage: {
      maxSize: 1024 * 1024 * 1024, // 1GB
      maxFiles: 100,
      maxFileSize: 10 * 1024 * 1024, // 10MB
    },
    api: {
      maxRequestsPerHour: 1000,
      maxRequestsPerDay: 10000,
      maxConcurrentRequests: 10,
    },
    backup: {
      maxBackups: 3,
      maxBackupSize: 100 * 1024 * 1024, // 100MB
      retentionDays: 7,
    },
    features: {
      enableReplicas: false,
      enablePITR: false,
      enableWebhooks: true,
      enableMigrations: true,
    },
  },
  pro: {
    userId: '',
    database: {
      maxSize: 10 * 1024 * 1024 * 1024, // 10GB
      maxTables: 100,
      maxConnections: 50,
      maxQueryTime: 60000, // 60 seconds
    },
    storage: {
      maxSize: 50 * 1024 * 1024 * 1024, // 50GB
      maxFiles: 10000,
      maxFileSize: 100 * 1024 * 1024, // 100MB
    },
    api: {
      maxRequestsPerHour: 10000,
      maxRequestsPerDay: 100000,
      maxConcurrentRequests: 50,
    },
    backup: {
      maxBackups: 10,
      maxBackupSize: 1024 * 1024 * 1024, // 1GB
      retentionDays: 30,
    },
    features: {
      enableReplicas: true,
      enablePITR: true,
      enableWebhooks: true,
      enableMigrations: true,
    },
  },
  enterprise: {
    userId: '',
    database: {
      maxSize: 1024 * 1024 * 1024 * 1024, // 1TB
      maxTables: 1000,
      maxConnections: 200,
      maxQueryTime: 300000, // 5 minutes
    },
    storage: {
      maxSize: 1024 * 1024 * 1024 * 1024, // 1TB
      maxFiles: 100000,
      maxFileSize: 1024 * 1024 * 1024, // 1GB
    },
    api: {
      maxRequestsPerHour: 100000,
      maxRequestsPerDay: 1000000,
      maxConcurrentRequests: 200,
    },
    backup: {
      maxBackups: 50,
      maxBackupSize: 10 * 1024 * 1024 * 1024, // 10GB
      retentionDays: 90,
    },
    features: {
      enableReplicas: true,
      enablePITR: true,
      enableWebhooks: true,
      enableMigrations: true,
    },
  },
}

export class ResourceQuotaManager {
  async getUserQuota(userId: string): Promise<ResourceQuota> {
    const result = await safeDb.safeSelect(`
      SELECT u.subscription_tier, rq.*
      FROM users u
      LEFT JOIN resource_quotas rq ON rq.user_id = u.id
      WHERE u.id = $1
    `, [userId])

    if (result.rows.length === 0) {
      throw new Error('User not found')
    }

    const user = result.rows[0]
    const tier = user.subscription_tier || 'free'

    // If custom quotas exist, use them; otherwise use defaults
    if (user.database_max_size !== null) {
      return {
        userId,
        database: {
          maxSize: user.database_max_size,
          maxTables: user.database_max_tables,
          maxConnections: user.database_max_connections,
          maxQueryTime: user.database_max_query_time,
        },
        storage: {
          maxSize: user.storage_max_size,
          maxFiles: user.storage_max_files,
          maxFileSize: user.storage_max_file_size,
        },
        api: {
          maxRequestsPerHour: user.api_max_requests_hour,
          maxRequestsPerDay: user.api_max_requests_day,
          maxConcurrentRequests: user.api_max_concurrent,
        },
        backup: {
          maxBackups: user.backup_max_count,
          maxBackupSize: user.backup_max_size,
          retentionDays: user.backup_retention_days,
        },
        features: {
          enableReplicas: user.feature_replicas,
          enablePITR: user.feature_pitr,
          enableWebhooks: user.feature_webhooks,
          enableMigrations: user.feature_migrations,
        },
      }
    }

    // Return default quotas for tier
    const defaultQuota = { ...DEFAULT_QUOTAS[tier] }
    defaultQuota.userId = userId
    return defaultQuota
  }

  async setUserQuota(userId: string, quota: Partial<ResourceQuota>): Promise<void> {
    await safeDb.safeInsert(`
      INSERT INTO resource_quotas (
        user_id,
        database_max_size, database_max_tables, database_max_connections, database_max_query_time,
        storage_max_size, storage_max_files, storage_max_file_size,
        api_max_requests_hour, api_max_requests_day, api_max_concurrent,
        backup_max_count, backup_max_size, backup_retention_days,
        feature_replicas, feature_pitr, feature_webhooks, feature_migrations,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        database_max_size = COALESCE($2, resource_quotas.database_max_size),
        database_max_tables = COALESCE($3, resource_quotas.database_max_tables),
        database_max_connections = COALESCE($4, resource_quotas.database_max_connections),
        database_max_query_time = COALESCE($5, resource_quotas.database_max_query_time),
        storage_max_size = COALESCE($6, resource_quotas.storage_max_size),
        storage_max_files = COALESCE($7, resource_quotas.storage_max_files),
        storage_max_file_size = COALESCE($8, resource_quotas.storage_max_file_size),
        api_max_requests_hour = COALESCE($9, resource_quotas.api_max_requests_hour),
        api_max_requests_day = COALESCE($10, resource_quotas.api_max_requests_day),
        api_max_concurrent = COALESCE($11, resource_quotas.api_max_concurrent),
        backup_max_count = COALESCE($12, resource_quotas.backup_max_count),
        backup_max_size = COALESCE($13, resource_quotas.backup_max_size),
        backup_retention_days = COALESCE($14, resource_quotas.backup_retention_days),
        feature_replicas = COALESCE($15, resource_quotas.feature_replicas),
        feature_pitr = COALESCE($16, resource_quotas.feature_pitr),
        feature_webhooks = COALESCE($17, resource_quotas.feature_webhooks),
        feature_migrations = COALESCE($18, resource_quotas.feature_migrations),
        updated_at = NOW()
    `, [
      userId,
      quota.database?.maxSize,
      quota.database?.maxTables,
      quota.database?.maxConnections,
      quota.database?.maxQueryTime,
      quota.storage?.maxSize,
      quota.storage?.maxFiles,
      quota.storage?.maxFileSize,
      quota.api?.maxRequestsPerHour,
      quota.api?.maxRequestsPerDay,
      quota.api?.maxConcurrentRequests,
      quota.backup?.maxBackups,
      quota.backup?.maxBackupSize,
      quota.backup?.retentionDays,
      quota.features?.enableReplicas,
      quota.features?.enablePITR,
      quota.features?.enableWebhooks,
      quota.features?.enableMigrations,
    ])
  }

  async getCurrentUsage(userId: string): Promise<ResourceUsage> {
    const [dbMetrics, storageUsage, apiUsage, backupUsage] = await Promise.all([
      this.getDatabaseUsage(userId),
      this.getStorageUsage(userId),
      this.getApiUsage(userId),
      this.getBackupUsage(userId),
    ])

    return {
      userId,
      timestamp: new Date(),
      database: dbMetrics,
      storage: storageUsage,
      api: apiUsage,
      backup: backupUsage,
    }
  }

  private async getDatabaseUsage(userId: string) {
    // Get database size and table count
    const dbResult = await safeDb.safeSelect(`
      SELECT 
        pg_database_size(current_database()) as db_size,
        (SELECT COUNT(*) FROM information_schema.tables 
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE') as table_count
    `)

    // Get connection count for user (approximation)
    const connResult = await safeDb.safeSelect(`
      SELECT COUNT(*) as connections
      FROM pg_stat_activity 
      WHERE usename = (SELECT email FROM users WHERE id = $1)
    `, [userId])

    // Get query metrics from our internal tracking
    const queryMetrics = safeDb.getMetrics()

    const dbStats = dbResult.rows[0]
    const connStats = connResult.rows[0]

    return {
      size: parseInt(dbStats.db_size) || 0,
      tables: parseInt(dbStats.table_count) || 0,
      connections: parseInt(connStats.connections) || 0,
      queryCount: queryMetrics.totalQueries || 0,
      averageQueryTime: queryMetrics.averageExecutionTime || 0,
    }
  }

  private async getStorageUsage(userId: string) {
    const result = await safeDb.safeSelect(`
      SELECT 
        COUNT(*) as file_count,
        COALESCE(SUM(size), 0) as total_size,
        COALESCE(MAX(size), 0) as largest_file
      FROM storage_files 
      WHERE user_id = $1
    `, [userId])

    const stats = result.rows[0]
    return {
      size: parseInt(stats.total_size) || 0,
      files: parseInt(stats.file_count) || 0,
      largestFile: parseInt(stats.largest_file) || 0,
    }
  }

  private async getApiUsage(userId: string) {
    const now = new Date()
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const dayStart = new Date(now.setHours(0, 0, 0, 0))

    const result = await safeDb.safeSelect(`
      SELECT 
        COUNT(*) FILTER (WHERE created_at > $1) as requests_hour,
        COUNT(*) FILTER (WHERE created_at > $2) as requests_day,
        0 as concurrent_requests -- Would track this in real-time
      FROM api_request_log 
      WHERE user_id = $3
    `, [hourAgo, dayStart, userId])

    const stats = result.rows[0] || { requests_hour: 0, requests_day: 0, concurrent_requests: 0 }

    return {
      requestsLastHour: parseInt(stats.requests_hour) || 0,
      requestsToday: parseInt(stats.requests_day) || 0,
      concurrentRequests: parseInt(stats.concurrent_requests) || 0,
    }
  }

  private async getBackupUsage(userId: string) {
    const backups = await dbManager.listBackups()
    
    // Filter backups for this user (in a multi-tenant system)
    const userBackups = backups.filter(backup => 
      backup.name.includes(userId) || backup.name.includes('user')
    )

    const totalSize = userBackups.reduce((sum, backup) => sum + backup.size, 0)
    const oldestBackup = userBackups.length > 0 
      ? userBackups.reduce((oldest, backup) => 
          backup.createdAt < oldest.createdAt ? backup : oldest
        ).createdAt
      : null

    return {
      count: userBackups.length,
      totalSize,
      oldestBackup,
    }
  }

  async checkQuotaViolation(userId: string, resource: keyof ResourceUsage, operation: 'create' | 'update' | 'delete', size?: number): Promise<{ allowed: boolean; message?: string }> {
    const [quota, usage] = await Promise.all([
      this.getUserQuota(userId),
      this.getCurrentUsage(userId),
    ])

    switch (resource) {
      case 'database':
        if (operation === 'create') {
          const newSize = usage.database.size + (size || 0)
          if (newSize > quota.database.maxSize) {
            return {
              allowed: false,
              message: `Database size would exceed quota (${this.formatBytes(newSize)} > ${this.formatBytes(quota.database.maxSize)})`
            }
          }
          
          if (usage.database.tables >= quota.database.maxTables) {
            return {
              allowed: false,
              message: `Maximum number of tables reached (${quota.database.maxTables})`
            }
          }
        }
        break

      case 'storage':
        if (operation === 'create') {
          const newSize = usage.storage.size + (size || 0)
          if (newSize > quota.storage.maxSize) {
            return {
              allowed: false,
              message: `Storage size would exceed quota (${this.formatBytes(newSize)} > ${this.formatBytes(quota.storage.maxSize)})`
            }
          }

          if (size && size > quota.storage.maxFileSize) {
            return {
              allowed: false,
              message: `File size exceeds maximum allowed (${this.formatBytes(size)} > ${this.formatBytes(quota.storage.maxFileSize)})`
            }
          }

          if (usage.storage.files >= quota.storage.maxFiles) {
            return {
              allowed: false,
              message: `Maximum number of files reached (${quota.storage.maxFiles})`
            }
          }
        }
        break

      case 'api':
        if (usage.api.requestsLastHour >= quota.api.maxRequestsPerHour) {
          return {
            allowed: false,
            message: `Hourly API request limit exceeded (${quota.api.maxRequestsPerHour})`
          }
        }

        if (usage.api.requestsToday >= quota.api.maxRequestsPerDay) {
          return {
            allowed: false,
            message: `Daily API request limit exceeded (${quota.api.maxRequestsPerDay})`
          }
        }

        if (usage.api.concurrentRequests >= quota.api.maxConcurrentRequests) {
          return {
            allowed: false,
            message: `Too many concurrent requests (${quota.api.maxConcurrentRequests})`
          }
        }
        break

      case 'backup':
        if (operation === 'create') {
          if (usage.backup.count >= quota.backup.maxBackups) {
            return {
              allowed: false,
              message: `Maximum number of backups reached (${quota.backup.maxBackups})`
            }
          }

          const newSize = usage.backup.totalSize + (size || 0)
          if (newSize > quota.backup.maxBackupSize) {
            return {
              allowed: false,
              message: `Backup storage would exceed quota (${this.formatBytes(newSize)} > ${this.formatBytes(quota.backup.maxBackupSize)})`
            }
          }
        }
        break
    }

    return { allowed: true }
  }

  async logResourceUsage(userId: string): Promise<void> {
    const usage = await this.getCurrentUsage(userId)

    await safeDb.safeInsert(`
      INSERT INTO resource_usage_log (
        user_id, timestamp,
        database_size, database_tables, database_connections, database_queries, database_avg_query_time,
        storage_size, storage_files, storage_largest_file,
        api_requests_hour, api_requests_day, api_concurrent,
        backup_count, backup_total_size, backup_oldest
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `, [
      userId, usage.timestamp,
      usage.database.size, usage.database.tables, usage.database.connections, 
      usage.database.queryCount, usage.database.averageQueryTime,
      usage.storage.size, usage.storage.files, usage.storage.largestFile,
      usage.api.requestsLastHour, usage.api.requestsToday, usage.api.concurrentRequests,
      usage.backup.count, usage.backup.totalSize, usage.backup.oldestBackup,
    ])
  }

  private formatBytes(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
    if (bytes === 0) return '0 Bytes'
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`
  }
}

export const quotaManager = new ResourceQuotaManager()