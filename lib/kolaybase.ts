// Kolaybase Client SDK
import type { AuthResponse, User, FileObject, RealtimeEvent } from "@/types"

export type ApiErrorShape = {
  code: string
  message: string
  details?: unknown
  status: number
}

export class ApiError extends Error {
  code: string
  details?: unknown
  status: number
  constructor({ code, message, details, status }: ApiErrorShape) {
    super(message)
    this.code = code
    this.details = details
    this.status = status
    this.name = "ApiError"
  }
}

class KolaybaseClient {
  private baseUrl: string
  private token?: string
  private isRefreshing = false
  private refreshListeners = new Set<(t: number) => void>()
  private lastRefreshAt?: number

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl
  }

  setToken(token: string) {
    this.token = token
  }

  startAutoRefresh(intervalMs = 10 * 60 * 1000) {
    if (typeof window === "undefined") return
    setInterval(() => {
      this.auth.refresh().catch(() => {})
    }, intervalMs)
  }

  getLastRefreshAt() {
    return this.lastRefreshAt
  }

  onRefresh(listener: (t: number) => void) {
    this.refreshListeners.add(listener)
    return () => this.refreshListeners.delete(listener)
  }

  private notifyRefresh() {
    this.lastRefreshAt = Date.now()
    this.refreshListeners.forEach((fn) => fn(this.lastRefreshAt!))
  }

  private async request(path: string, options: RequestInit = {}, triedRefresh = false): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers instanceof Headers ? {} : options.headers as Record<string, string>),
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    })

    const isJson = (response.headers.get("content-type") || "").includes("application/json")
    const body = isJson ? await response.json().catch(() => ({})) : undefined

    if (!response.ok) {
      const errorShape: ApiErrorShape = {
        code: (body && (body.code || body.error || "unknown_error")) as string,
        message: (body && (body.message || body.error_description || response.statusText)) as string,
        details: body && (body.details || body),
        status: response.status,
      }

      if (response.status === 401 && typeof window !== "undefined") {
        // Attempt one-time refresh before redirecting
        if (!triedRefresh) {
          try {
            await this.auth.refresh()
            return this.request(path, options, true)
          } catch {}
        }
        window.location.href = "/(auth)/sign-in"
      }

      throw new ApiError(errorShape)
    }

    return body
  }

  // Public wrapper so components can reuse standardized error handling
  async apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
    return this.request(path, options) as Promise<T>
  }

  // REST API
  rest = {
    get: (path: string) => this.request(`/api/rest${path}`, { method: "GET" }),
    post: (path: string, data: any) =>
      this.request(`/api/rest${path}`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    patch: (path: string, data: any) =>
      this.request(`/api/rest${path}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (path: string) => this.request(`/api/rest${path}`, { method: "DELETE" }),
  }

  // GraphQL
  graphql = async (query: string, variables?: Record<string, any>) => {
    return this.request("/api/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    })
  }

  // Realtime
  realtime = {
    subscribe: (table: string, callback: (event: RealtimeEvent) => void) => {
      // Mock implementation - in production would use WebSocket
      const interval = setInterval(() => {
        // Simulate random events
        if (Math.random() > 0.95) {
          callback({
            type: "INSERT",
            table,
            schema: "public",
            new_record: { id: Math.random().toString(), created_at: new Date().toISOString() },
            timestamp: new Date().toISOString(),
          })
        }
      }, 1000)

      return () => clearInterval(interval)
    },
  }

  // Storage
  storage = {
    list: async (bucket: string, path = ""): Promise<FileObject[]> => {
      return this.request(`/api/storage/${bucket}/list?path=${path}`)
    },
    upload: async (bucket: string, path: string, file: File) => {
      const formData = new FormData()
      formData.append("file", file)

      const response = await fetch(`${this.baseUrl}/api/storage/${bucket}/upload?path=${path}`, {
        method: "POST",
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        body: formData,
      })

      return response.json()
    },
    download: async (bucket: string, path: string): Promise<Blob> => {
      const response = await fetch(`${this.baseUrl}/api/storage/${bucket}/download?path=${path}`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      })
      return response.blob()
    },
    delete: async (bucket: string, paths: string[]) => {
      return this.request(`/api/storage/${bucket}/delete`, {
        method: "DELETE",
        body: JSON.stringify({ paths }),
      })
    },
  }

  // Auth
  auth = {
    signIn: async (email: string, password: string): Promise<AuthResponse> => {
      return this.request("/api/auth/signin", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      })
    },
    signUp: async (email: string, password: string): Promise<AuthResponse> => {
      return this.request("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      })
    },
    signOut: async () => {
      return this.request("/api/auth/signout", { method: "POST" })
    },
    refresh: async () => {
      if (this.isRefreshing) return
      this.isRefreshing = true
      try {
        await this.request("/api/auth/refresh", { method: "POST" })
        this.notifyRefresh()
      } finally {
        this.isRefreshing = false
      }
    },
    getUser: async (): Promise<User | null> => {
      try {
        return await this.request("/api/auth/user")
      } catch {
        return null
      }
    },
  }
}

export const kolaybase = new KolaybaseClient()

// Convenience wrapper for components that still call fetch directly
export async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  return kolaybase.apiFetch<T>(path, options)
}
