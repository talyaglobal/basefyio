export interface RateLimitConfig {
  windowMs: number // Time window in milliseconds
  maxRequests: number // Maximum requests per window
  keyGenerator?: (identifier: string) => string
}

export interface RateLimitResult {
  allowed: boolean
  resetTime: number
  remaining: number
  limit: number
}

class InMemoryStore {
  private store = new Map<string, { count: number; resetTime: number }>()

  get(key: string): { count: number; resetTime: number } | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    
    // Clean up expired entries
    if (Date.now() > entry.resetTime) {
      this.store.delete(key)
      return undefined
    }
    
    return entry
  }

  set(key: string, count: number, resetTime: number): void {
    this.store.set(key, { count, resetTime })
  }

  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.resetTime) {
        this.store.delete(key)
      }
    }
  }
}

export class RateLimiter {
  private store = new InMemoryStore()
  private config: RateLimitConfig

  constructor(config: RateLimitConfig) {
    this.config = config
    
    // Clean up expired entries every 5 minutes
    setInterval(() => this.store.cleanup(), 5 * 60 * 1000)
  }

  async checkLimit(identifier: string): Promise<RateLimitResult> {
    const key = this.config.keyGenerator ? this.config.keyGenerator(identifier) : identifier
    const now = Date.now()
    const resetTime = now + this.config.windowMs
    
    const existing = this.store.get(key)
    
    if (!existing) {
      // First request in window
      this.store.set(key, 1, resetTime)
      return {
        allowed: true,
        resetTime,
        remaining: this.config.maxRequests - 1,
        limit: this.config.maxRequests,
      }
    }
    
    if (existing.count >= this.config.maxRequests) {
      // Rate limit exceeded
      return {
        allowed: false,
        resetTime: existing.resetTime,
        remaining: 0,
        limit: this.config.maxRequests,
      }
    }
    
    // Increment counter
    this.store.set(key, existing.count + 1, existing.resetTime)
    
    return {
      allowed: true,
      resetTime: existing.resetTime,
      remaining: this.config.maxRequests - existing.count - 1,
      limit: this.config.maxRequests,
    }
  }
}

// Default rate limiters for different use cases
export const globalRateLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 1000, // 1000 requests per 15 minutes
})

export const authRateLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes  
  maxRequests: 10, // 10 auth attempts per 15 minutes
  keyGenerator: (ip) => `auth:${ip}`,
})

export const apiKeyRateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100, // 100 requests per minute per API key
  keyGenerator: (keyId) => `api_key:${keyId}`,
})

export const ipRateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60, // 60 requests per minute per IP
  keyGenerator: (ip) => `ip:${ip}`,
})

export function getClientIp(request: Request): string {
  // Try various headers for IP address
  const forwarded = request.headers.get("x-forwarded-for")
  const realIp = request.headers.get("x-real-ip")
  const clientIp = request.headers.get("x-client-ip")
  
  if (forwarded) {
    return forwarded.split(",")[0].trim()
  }
  
  return realIp || clientIp || "unknown"
}

export async function rateLimitByIp(request: Request): Promise<RateLimitResult> {
  const ip = getClientIp(request)
  return await ipRateLimiter.checkLimit(ip)
}

export async function rateLimitByApiKey(apiKeyId: string): Promise<RateLimitResult> {
  return await apiKeyRateLimiter.checkLimit(apiKeyId)
}

export async function rateLimitAuth(request: Request): Promise<RateLimitResult> {
  const ip = getClientIp(request)
  return await authRateLimiter.checkLimit(ip)
}