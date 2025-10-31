import { createHash, createHmac } from "crypto"

export interface SignedUrlOptions {
  bucket?: string
  key: string
  expiresIn?: number // seconds, default 3600 (1 hour)
  method?: "GET" | "POST" | "PUT" | "DELETE"
  contentType?: string
  contentLength?: number
}

export interface SignedUrlResult {
  url: string
  expiresAt: Date
  fields?: Record<string, string>
}

const STORAGE_SECRET = process.env.STORAGE_SECRET || process.env.JWT_SECRET || "storage-secret"
const BASE_URL = process.env.STORAGE_BASE_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000"

export function generateSignedUrl(options: SignedUrlOptions): SignedUrlResult {
  const {
    bucket = "default",
    key,
    expiresIn = 3600,
    method = "GET",
    contentType,
    contentLength,
  } = options

  const expiresAt = new Date(Date.now() + expiresIn * 1000)
  const expires = Math.floor(expiresAt.getTime() / 1000)

  // Create payload for signing
  const payload = {
    bucket,
    key,
    method,
    expires,
    ...(contentType && { contentType }),
    ...(contentLength && { contentLength }),
  }

  // Generate signature
  const signature = createHmac("sha256", STORAGE_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex")

  // Create signed URL
  const params = new URLSearchParams({
    bucket,
    key,
    method,
    expires: expires.toString(),
    signature,
    ...(contentType && { contentType }),
    ...(contentLength && { contentLength: contentLength.toString() }),
  })

  const url = `${BASE_URL}/api/storage/signed?${params.toString()}`

  const result: SignedUrlResult = {
    url,
    expiresAt,
  }

  // For POST/PUT operations, include form fields
  if (method === "POST" || method === "PUT") {
    result.fields = {
      bucket,
      key,
      signature,
      expires: expires.toString(),
      ...(contentType && { "Content-Type": contentType }),
    }
  }

  return result
}

export function verifySignedUrl(params: URLSearchParams): {
  valid: boolean
  expired?: boolean
  payload?: any
  error?: string
} {
  const bucket = params.get("bucket")
  const key = params.get("key")
  const method = params.get("method") || "GET"
  const expires = params.get("expires")
  const signature = params.get("signature")
  const contentType = params.get("contentType")
  const contentLength = params.get("contentLength")

  if (!bucket || !key || !expires || !signature) {
    return {
      valid: false,
      error: "Missing required parameters",
    }
  }

  const expiresTimestamp = parseInt(expires, 10)
  const now = Math.floor(Date.now() / 1000)

  if (expiresTimestamp < now) {
    return {
      valid: false,
      expired: true,
      error: "URL has expired",
    }
  }

  // Recreate payload and verify signature
  const payload = {
    bucket,
    key,
    method,
    expires: expiresTimestamp,
    ...(contentType && { contentType }),
    ...(contentLength && { contentLength: parseInt(contentLength, 10) }),
  }

  const expectedSignature = createHmac("sha256", STORAGE_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex")

  if (signature !== expectedSignature) {
    return {
      valid: false,
      error: "Invalid signature",
    }
  }

  return {
    valid: true,
    payload,
  }
}

export function generateFileKey(userId: string, originalName: string): string {
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).substring(2, 15)
  const extension = originalName.split(".").pop()
  const baseName = originalName.split(".").slice(0, -1).join(".")
  const sanitizedName = baseName.replace(/[^a-zA-Z0-9_-]/g, "_")

  return `users/${userId}/${timestamp}_${randomSuffix}_${sanitizedName}${extension ? `.${extension}` : ""}`
}

export function calculateFileChecksum(content: Buffer): string {
  return createHash("md5").update(content).digest("hex")
}

export interface StorageQuota {
  used: number
  limit: number
  remaining: number
  usage: number // percentage
}

export function calculateQuotaUsage(files: Array<{ size: number }>, limit: number = 1024 * 1024 * 1024): StorageQuota {
  const used = files.reduce((total, file) => total + file.size, 0)
  const remaining = Math.max(0, limit - used)
  const usage = Math.min(100, (used / limit) * 100)

  return {
    used,
    limit,
    remaining,
    usage,
  }
}