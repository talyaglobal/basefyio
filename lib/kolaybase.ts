// Kolaybase Client SDK
import type { AuthResponse, User, FileObject, RealtimeEvent } from "@/types"

class KolaybaseClient {
  private baseUrl: string
  private token?: string

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl
  }

  setToken(token: string) {
    this.token = token
  }

  private async request(path: string, options: RequestInit = {}) {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      ...options.headers,
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`)
    }

    return response.json()
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
