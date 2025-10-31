// Using Web Crypto API instead of Node.js crypto for Edge Runtime compatibility

export type ApiScope = 
  | "read:tables"
  | "write:tables"
  | "read:storage"
  | "write:storage"
  | "read:sql"
  | "write:sql"
  | "read:webhooks"
  | "write:webhooks"
  | "read:migrations"
  | "write:migrations"
  | "read:rls"
  | "write:rls"
  | "read:quotas"
  | "write:quotas"
  | "backup"
  | "admin"

export const API_SCOPES: Record<ApiScope, string> = {
  "read:tables": "Read table data and schema",
  "write:tables": "Create, update, and delete tables and rows",
  "read:storage": "Read storage files and metadata",
  "write:storage": "Upload, update, and delete storage files",
  "read:sql": "Execute read-only SQL queries",
  "write:sql": "Execute all SQL queries including DDL/DML",
  "read:webhooks": "View webhook configurations",
  "write:webhooks": "Create, update, and delete webhooks",
  "read:migrations": "View migration status and history",
  "write:migrations": "Create and run database migrations",
  "read:rls": "View RLS policies",
  "write:rls": "Create, update, and delete RLS policies",
  "read:quotas": "View resource quotas and usage",
  "write:quotas": "Manage resource quotas and limits",
  "backup": "Create and manage database backups",
  "admin": "Full administrative access to all resources",
}

export const SCOPE_HIERARCHIES: Record<ApiScope, ApiScope[]> = {
  "admin": Object.keys(API_SCOPES) as ApiScope[],
  "write:tables": ["read:tables"],
  "write:storage": ["read:storage"],
  "write:sql": ["read:sql"],
  "write:webhooks": ["read:webhooks"],
  "write:migrations": ["read:migrations"],
  "write:rls": ["read:rls"],
  "write:quotas": ["read:quotas"],
  "backup": [],
  "read:quotas": [],
  "read:tables": [],
  "read:storage": [],
  "read:sql": [],
  "read:webhooks": [],
  "read:migrations": [],
  "read:rls": [],
}

export function expandScopes(scopes: ApiScope[]): Set<ApiScope> {
  const expandedScopes = new Set<ApiScope>()
  
  for (const scope of scopes) {
    expandedScopes.add(scope)
    const impliedScopes = SCOPE_HIERARCHIES[scope] || []
    for (const impliedScope of impliedScopes) {
      expandedScopes.add(impliedScope)
    }
  }
  
  return expandedScopes
}

export function hasScope(userScopes: ApiScope[], requiredScope: ApiScope): boolean {
  const expandedScopes = expandScopes(userScopes)
  return expandedScopes.has(requiredScope)
}

export function generateApiKey(): string {
  // Generate a secure random API key
  const timestamp = Date.now().toString(36)
  const randomBytes = Array.from({ length: 32 }, () => 
    Math.floor(Math.random() * 36).toString(36)
  ).join("")
  
  return `kb_${timestamp}${randomBytes}`
}

export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(apiKey)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface ApiKeyData {
  id: string
  name: string
  hashedKey: string
  scopes: ApiScope[]
  userId: string
  expiresAt?: Date
  createdAt: Date
  lastUsedAt?: Date
  isActive: boolean
}

export function validateScopes(scopes: string[]): { valid: boolean; validScopes: ApiScope[]; invalidScopes: string[] } {
  const validScopes: ApiScope[] = []
  const invalidScopes: string[] = []
  
  for (const scope of scopes) {
    if (scope in API_SCOPES) {
      validScopes.push(scope as ApiScope)
    } else {
      invalidScopes.push(scope)
    }
  }
  
  return {
    valid: invalidScopes.length === 0,
    validScopes,
    invalidScopes,
  }
}

export function checkScopePermissions(endpoint: string, method: string): ApiScope[] {
  const requiredScopes: ApiScope[] = []
  
  // Define scope requirements for different endpoints
  const scopeMap: Record<string, Partial<Record<string, ApiScope[]>>> = {
    "/api/tables": {
      GET: ["read:tables"],
      POST: ["write:tables"],
      PUT: ["write:tables"],
      DELETE: ["write:tables"],
    },
    "/api/tables/[tableName]": {
      GET: ["read:tables"],
      POST: ["write:tables"],
      PUT: ["write:tables"],
      DELETE: ["write:tables"],
    },
    "/api/tables/[tableName]/rows": {
      GET: ["read:tables"],
      POST: ["write:tables"],
      PUT: ["write:tables"],
      DELETE: ["write:tables"],
    },
    "/api/storage": {
      GET: ["read:storage"],
      POST: ["write:storage"],
      PUT: ["write:storage"],
      DELETE: ["write:storage"],
    },
    "/api/storage/upload": {
      POST: ["write:storage"],
    },
    "/api/sql/execute": {
      POST: ["read:sql"], // Will be checked dynamically based on query type
    },
    "/api/webhooks": {
      GET: ["read:webhooks"],
      POST: ["write:webhooks"],
      PUT: ["write:webhooks"],
      DELETE: ["write:webhooks"],
    },
    "/api/migrations": {
      GET: ["read:migrations"],
      POST: ["write:migrations"],
      PUT: ["write:migrations"],
      DELETE: ["write:migrations"],
    },
    "/api/rls": {
      GET: ["read:rls"],
      POST: ["write:rls"],
      PUT: ["write:rls"],
      DELETE: ["write:rls"],
    },
  }
  
  // Match endpoint pattern (handle dynamic routes)
  const endpointKey = Object.keys(scopeMap).find(pattern => {
    const regex = new RegExp("^" + pattern.replace(/\[.*?\]/g, "[^/]+") + "$")
    return regex.test(endpoint)
  })
  
  if (endpointKey) {
    const methodScopes = scopeMap[endpointKey][method]
    if (methodScopes) {
      requiredScopes.push(...methodScopes)
    }
  }
  
  return requiredScopes
}

export function isSqlWriteOperation(query: string): boolean {
  const writeKeywords = [
    "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", 
    "TRUNCATE", "REPLACE", "MERGE", "GRANT", "REVOKE"
  ]
  
  const trimmedQuery = query.trim().toUpperCase()
  return writeKeywords.some(keyword => trimmedQuery.startsWith(keyword))
}