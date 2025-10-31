import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto'
import { promisify } from 'util'
import { safeDb } from './db-safety'

const scryptAsync = promisify(scrypt)

export interface Secret {
  id: string
  name: string
  description?: string
  encrypted_value: string
  key_id: string
  created_by: string
  created_at: string
  updated_at: string
  expires_at?: string
  last_accessed_at?: string
  access_count: number
}

export interface SecretPermission {
  id: string
  secret_id: string
  user_id?: string
  function_id?: string
  permission: 'read' | 'write' | 'admin'
  granted_by: string
  created_at: string
  expires_at?: string
}

export class SecretsManager {
  private encryptionKeys: Map<string, Buffer> = new Map()
  private masterKey: string

  constructor() {
    this.masterKey = process.env.KOLAYBASE_MASTER_KEY || this.generateMasterKey()
    if (!process.env.KOLAYBASE_MASTER_KEY) {
      console.warn('⚠️ KOLAYBASE_MASTER_KEY not set. Generated temporary key. Set environment variable for production.')
    }
  }

  private generateMasterKey(): string {
    return randomBytes(32).toString('hex')
  }

  private async getOrCreateEncryptionKey(keyId: string): Promise<Buffer> {
    if (this.encryptionKeys.has(keyId)) {
      return this.encryptionKeys.get(keyId)!
    }

    // Derive key from master key and key ID
    const key = await scryptAsync(this.masterKey, keyId, 32) as Buffer
    this.encryptionKeys.set(keyId, key)
    return key
  }

  private generateKeyId(): string {
    return `key_${Date.now()}_${randomBytes(8).toString('hex')}`
  }

  async encrypt(plaintext: string, keyId?: string): Promise<{ encrypted: string; keyId: string }> {
    const actualKeyId = keyId || this.generateKeyId()
    const key = await this.getOrCreateEncryptionKey(actualKeyId)
    
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    
    const authTag = cipher.getAuthTag()
    
    // Combine IV, auth tag, and encrypted data
    const combined = iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted
    
    return {
      encrypted: combined,
      keyId: actualKeyId
    }
  }

  async decrypt(encryptedData: string, keyId: string): Promise<string> {
    const key = await this.getOrCreateEncryptionKey(keyId)
    
    const parts = encryptedData.split(':')
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format')
    }
    
    const iv = Buffer.from(parts[0], 'hex')
    const authTag = Buffer.from(parts[1], 'hex')
    const encrypted = parts[2]
    
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    
    return decrypted
  }

  async createSecret(
    name: string, 
    value: string, 
    createdBy: string,
    options: {
      description?: string
      expiresAt?: Date
    } = {}
  ): Promise<string> {
    // Check if secret already exists
    const existing = await safeDb.safeSelect(`
      SELECT id FROM secrets WHERE name = $1
    `, [name])

    if (existing.rows.length > 0) {
      throw new Error(`Secret with name '${name}' already exists`)
    }

    // Encrypt the value
    const { encrypted, keyId } = await this.encrypt(value)

    const result = await safeDb.safeInsert(`
      INSERT INTO secrets (name, description, encrypted_value, key_id, created_by, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), $6)
      RETURNING id, name, created_at
    `, [
      name,
      options.description,
      encrypted,
      keyId,
      createdBy,
      options.expiresAt?.toISOString()
    ])

    console.log(`🔐 Created secret: ${name}`)
    return result.rows[0].id
  }

  async getSecret(name: string, userId?: string, functionId?: string): Promise<string> {
    // Get secret and check permissions
    const result = await safeDb.safeSelect(`
      SELECT s.*, 
             CASE 
               WHEN s.created_by = $2 THEN 'admin'
               WHEN sp.permission IS NOT NULL THEN sp.permission
               ELSE NULL
             END as user_permission
      FROM secrets s
      LEFT JOIN secret_permissions sp ON s.id = sp.secret_id 
        AND (sp.user_id = $2 OR sp.function_id = $3)
        AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
      WHERE s.name = $1 
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
    `, [name, userId, functionId])

    if (result.rows.length === 0) {
      throw new Error(`Secret '${name}' not found`)
    }

    const secret = result.rows[0]

    // Check permissions
    if (!secret.user_permission && secret.created_by !== userId) {
      throw new Error(`Access denied to secret '${name}'`)
    }

    if (secret.user_permission && !['read', 'write', 'admin'].includes(secret.user_permission)) {
      throw new Error(`Access denied to secret '${name}'`)
    }

    // Decrypt the value
    const decryptedValue = await this.decrypt(secret.encrypted_value, secret.key_id)

    // Update access tracking
    await safeDb.safeUpdate(`
      UPDATE secrets 
      SET last_accessed_at = NOW(), access_count = access_count + 1
      WHERE id = $1
    `, [secret.id])

    return decryptedValue
  }

  async updateSecret(
    name: string, 
    newValue: string, 
    userId: string,
    options: {
      description?: string
      expiresAt?: Date
    } = {}
  ): Promise<void> {
    // Check if user has write permission
    const result = await safeDb.safeSelect(`
      SELECT s.*, 
             CASE 
               WHEN s.created_by = $2 THEN 'admin'
               WHEN sp.permission IN ('write', 'admin') THEN sp.permission
               ELSE NULL
             END as user_permission
      FROM secrets s
      LEFT JOIN secret_permissions sp ON s.id = sp.secret_id 
        AND sp.user_id = $2
        AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
      WHERE s.name = $1 
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
    `, [name, userId])

    if (result.rows.length === 0) {
      throw new Error(`Secret '${name}' not found`)
    }

    const secret = result.rows[0]

    if (!secret.user_permission && secret.created_by !== userId) {
      throw new Error(`Access denied to secret '${name}'`)
    }

    // Encrypt new value (potentially with new key for rotation)
    const { encrypted, keyId } = await this.encrypt(newValue)

    const updates: string[] = ['encrypted_value = $2', 'key_id = $3', 'updated_at = NOW()']
    const params: any[] = [secret.id, encrypted, keyId]

    if (options.description !== undefined) {
      updates.push(`description = $${params.length + 1}`)
      params.push(options.description)
    }

    if (options.expiresAt !== undefined) {
      updates.push(`expires_at = $${params.length + 1}`)
      params.push(options.expiresAt.toISOString())
    }

    await safeDb.safeUpdate(`
      UPDATE secrets 
      SET ${updates.join(', ')}
      WHERE id = $1
    `, params)

    console.log(`🔐 Updated secret: ${name}`)
  }

  async deleteSecret(name: string, userId: string): Promise<void> {
    // Check if user has admin permission
    const result = await safeDb.safeSelect(`
      SELECT s.*, 
             CASE 
               WHEN s.created_by = $2 THEN 'admin'
               WHEN sp.permission = 'admin' THEN sp.permission
               ELSE NULL
             END as user_permission
      FROM secrets s
      LEFT JOIN secret_permissions sp ON s.id = sp.secret_id 
        AND sp.user_id = $2
        AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
      WHERE s.name = $1
    `, [name, userId])

    if (result.rows.length === 0) {
      throw new Error(`Secret '${name}' not found`)
    }

    const secret = result.rows[0]

    if (secret.created_by !== userId && secret.user_permission !== 'admin') {
      throw new Error(`Access denied to delete secret '${name}'`)
    }

    // Delete secret and all permissions
    await safeDb.safeDelete(`
      DELETE FROM secrets WHERE id = $1
    `, [secret.id])

    console.log(`🗑️ Deleted secret: ${name}`)
  }

  async listSecrets(userId: string, options: {
    limit?: number
    offset?: number
    includeExpired?: boolean
  } = {}): Promise<Array<Omit<Secret, 'encrypted_value' | 'key_id'>>> {
    const { limit = 50, offset = 0, includeExpired = false } = options

    let query = `
      SELECT s.id, s.name, s.description, s.created_by, s.created_at, s.updated_at,
             s.expires_at, s.last_accessed_at, s.access_count,
             CASE 
               WHEN s.created_by = $1 THEN 'admin'
               WHEN sp.permission IS NOT NULL THEN sp.permission
               ELSE NULL
             END as user_permission
      FROM secrets s
      LEFT JOIN secret_permissions sp ON s.id = sp.secret_id 
        AND sp.user_id = $1
        AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
      WHERE (s.created_by = $1 OR sp.permission IS NOT NULL)
    `

    const params = [userId]

    if (!includeExpired) {
      query += ` AND (s.expires_at IS NULL OR s.expires_at > NOW())`
    }

    query += ` ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(limit.toString(), offset.toString())

    const result = await safeDb.safeSelect(query, params)

    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
      last_accessed_at: row.last_accessed_at,
      access_count: row.access_count,
      permission: row.user_permission
    }))
  }

  async grantPermission(
    secretName: string,
    grantedBy: string,
    target: { userId?: string; functionId?: string },
    permission: 'read' | 'write' | 'admin',
    expiresAt?: Date
  ): Promise<void> {
    // Get secret and verify grantor permissions
    const result = await safeDb.safeSelect(`
      SELECT s.*, 
             CASE 
               WHEN s.created_by = $2 THEN 'admin'
               WHEN sp.permission = 'admin' THEN sp.permission
               ELSE NULL
             END as grantor_permission
      FROM secrets s
      LEFT JOIN secret_permissions sp ON s.id = sp.secret_id 
        AND sp.user_id = $2
        AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
      WHERE s.name = $1
    `, [secretName, grantedBy])

    if (result.rows.length === 0) {
      throw new Error(`Secret '${secretName}' not found`)
    }

    const secret = result.rows[0]

    if (secret.created_by !== grantedBy && secret.grantor_permission !== 'admin') {
      throw new Error(`Access denied to grant permissions for secret '${secretName}'`)
    }

    // Insert or update permission
    await safeDb.safeInsert(`
      INSERT INTO secret_permissions (secret_id, user_id, function_id, permission, granted_by, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), $6)
      ON CONFLICT (secret_id, user_id) DO UPDATE SET
        permission = EXCLUDED.permission,
        granted_by = EXCLUDED.granted_by,
        expires_at = EXCLUDED.expires_at
    `, [
      secret.id,
      target.userId,
      target.functionId,
      permission,
      grantedBy,
      expiresAt?.toISOString()
    ])

    const targetType = target.userId ? 'user' : 'function'
    const targetId = target.userId || target.functionId
    console.log(`🔑 Granted ${permission} permission on secret '${secretName}' to ${targetType} ${targetId}`)
  }

  async revokePermission(
    secretName: string,
    revokedBy: string,
    target: { userId?: string; functionId?: string }
  ): Promise<void> {
    // Get secret and verify revoker permissions
    const result = await safeDb.safeSelect(`
      SELECT s.*, 
             CASE 
               WHEN s.created_by = $2 THEN 'admin'
               WHEN sp.permission = 'admin' THEN sp.permission
               ELSE NULL
             END as revoker_permission
      FROM secrets s
      LEFT JOIN secret_permissions sp ON s.id = sp.secret_id 
        AND sp.user_id = $2
        AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
      WHERE s.name = $1
    `, [secretName, revokedBy])

    if (result.rows.length === 0) {
      throw new Error(`Secret '${secretName}' not found`)
    }

    const secret = result.rows[0]

    if (secret.created_by !== revokedBy && secret.revoker_permission !== 'admin') {
      throw new Error(`Access denied to revoke permissions for secret '${secretName}'`)
    }

    // Delete permission
    let deleteQuery = 'DELETE FROM secret_permissions WHERE secret_id = $1'
    const params = [secret.id]

    if (target.userId) {
      deleteQuery += ` AND user_id = $${params.length + 1}`
      params.push(target.userId)
    } else if (target.functionId) {
      deleteQuery += ` AND function_id = $${params.length + 1}`
      params.push(target.functionId)
    }

    await safeDb.safeDelete(deleteQuery, params)

    const targetType = target.userId ? 'user' : 'function'
    const targetId = target.userId || target.functionId
    console.log(`❌ Revoked permission on secret '${secretName}' from ${targetType} ${targetId}`)
  }

  async rotateKey(secretName: string, userId: string): Promise<void> {
    // Get current secret
    const currentValue = await this.getSecret(secretName, userId)
    
    // Re-encrypt with new key
    const { encrypted, keyId } = await this.encrypt(currentValue)

    await safeDb.safeUpdate(`
      UPDATE secrets 
      SET encrypted_value = $2, key_id = $3, updated_at = NOW()
      WHERE name = $1
    `, [secretName, encrypted, keyId])

    console.log(`🔄 Rotated encryption key for secret: ${secretName}`)
  }

  async cleanupExpiredSecrets(): Promise<number> {
    const result = await safeDb.safeDelete(`
      DELETE FROM secrets 
      WHERE expires_at IS NOT NULL AND expires_at <= NOW()
    `)

    const deletedCount = result.rowCount || 0
    if (deletedCount > 0) {
      console.log(`🧹 Cleaned up ${deletedCount} expired secrets`)
    }

    return deletedCount
  }

  // For edge functions to access secrets
  async getSecretsForFunction(functionId: string): Promise<Record<string, string>> {
    const result = await safeDb.safeSelect(`
      SELECT s.name, s.encrypted_value, s.key_id
      FROM secrets s
      JOIN secret_permissions sp ON s.id = sp.secret_id
      WHERE sp.function_id = $1 
        AND sp.permission IN ('read', 'write', 'admin')
        AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
    `, [functionId])

    const secrets: Record<string, string> = {}

    for (const row of result.rows) {
      try {
        const decryptedValue = await this.decrypt(row.encrypted_value, row.key_id)
        secrets[row.name] = decryptedValue
      } catch (error) {
        console.error(`Failed to decrypt secret ${row.name}:`, error)
      }
    }

    return secrets
  }
}

export const secretsManager = new SecretsManager()

// Cleanup expired secrets every hour
setInterval(() => {
  secretsManager.cleanupExpiredSecrets().catch(console.error)
}, 60 * 60 * 1000)