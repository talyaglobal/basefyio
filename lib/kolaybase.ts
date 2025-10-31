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
    connect: () => {
      const wsUrl = this.baseUrl.replace(/^https?/, 'ws') + '/realtime'
      const token = this.token
      
      let ws: WebSocket | null = null
      let reconnectAttempts = 0
      const maxReconnectAttempts = 5
      let reconnectTimeout: NodeJS.Timeout | null = null
      
      const connect = () => {
        try {
          const url = new URL(wsUrl)
          if (token) {
            url.searchParams.set('token', token)
          }
          
          ws = new WebSocket(url.toString())
          
          ws.onopen = () => {
            console.log('✅ Connected to Kolaybase Realtime')
            reconnectAttempts = 0
          }
          
          ws.onerror = (error) => {
            console.error('WebSocket error:', error)
          }
          
          ws.onclose = () => {
            console.log('WebSocket closed')
            // Attempt to reconnect
            if (reconnectAttempts < maxReconnectAttempts) {
              reconnectAttempts++
              const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
              console.log(`Reconnecting in ${delay}ms...`)
              reconnectTimeout = setTimeout(connect, delay)
            }
          }
        } catch (error) {
          console.error('Failed to connect to WebSocket:', error)
        }
      }
      
      connect()
      
      return {
        ws,
        subscribe: (table: string, schema: string = 'public', callback: (event: RealtimeEvent) => void) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not connected, waiting...')
            const checkConnection = setInterval(() => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                clearInterval(checkConnection)
                this.realtime.connect().subscribe(table, schema, callback)
              }
            }, 100)
            return () => clearInterval(checkConnection)
          }
          
          // Send subscription message
          ws.send(JSON.stringify({
            type: 'subscribe',
            payload: { table, schema }
          }))
          
          // Listen for messages
          const messageHandler = (event: MessageEvent) => {
            try {
              const data = JSON.parse(event.data)
              if (data.table === table && data.schema === schema) {
                callback({
                  type: data.type.toUpperCase(),
                  table: data.table,
                  schema: data.schema,
                  new_record: data.payload?.new_record,
                  old_record: data.payload?.old_record,
                  timestamp: data.timestamp
                } as RealtimeEvent)
              }
            } catch (error) {
              console.error('Error parsing WebSocket message:', error)
            }
          }
          
          ws.addEventListener('message', messageHandler)
          
          return () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'unsubscribe',
                payload: { table, schema }
              }))
            }
            ws?.removeEventListener('message', messageHandler)
          }
        },
        channel: (channelId: string) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected')
          }
          
          return {
            subscribe: () => {
              ws?.send(JSON.stringify({
                type: 'subscribe',
                payload: { channel: channelId }
              }))
            },
            unsubscribe: () => {
              ws?.send(JSON.stringify({
                type: 'unsubscribe',
                payload: { channel: channelId }
              }))
            },
            send: (event: string, payload: any) => {
              ws?.send(JSON.stringify({
                type: 'broadcast',
                payload: { channel: channelId, event, payload }
              }))
            },
            onPresence: (callback: (presence: any) => void) => {
              const handler = (event: MessageEvent) => {
                try {
                  const data = JSON.parse(event.data)
                  if (data.channel === channelId && data.type === 'presence') {
                    callback(data.payload)
                  }
                } catch (error) {
                  console.error('Error parsing presence:', error)
                }
              }
              ws?.addEventListener('message', handler)
              return () => ws?.removeEventListener('message', handler)
            },
            onMessage: (event: string, callback: (payload: any) => void) => {
              const handler = (msg: MessageEvent) => {
                try {
                  const data = JSON.parse(msg.data)
                  if (data.channel === channelId && data.type === 'broadcast' && data.payload?.event === event) {
                    callback(data.payload.payload)
                  }
                } catch (error) {
                  console.error('Error parsing message:', error)
                }
              }
              ws?.addEventListener('message', handler)
              return () => ws?.removeEventListener('message', handler)
            }
          }
        },
        disconnect: () => {
          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout)
          }
          ws?.close()
          ws = null
        }
      }
    },
    // Legacy subscribe method for backward compatibility
    subscribe: (table: string, callback: (event: RealtimeEvent) => void) => {
      const client = this.realtime.connect()
      return client.subscribe(table, 'public', callback)
    },
    // SSE-based subscribe (simpler, uses /api/realtime endpoint)
    subscribeSSE: (table: string, callback: (event: RealtimeEvent) => void) => {
      if (typeof window === "undefined") {
        return () => {}
      }

      const url = new URL(`${this.baseUrl}/api/realtime`)
      url.searchParams.set("table", table)
      const eventSource = new EventSource(url.toString())

      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.type && data.type !== "PING") {
            callback(data as RealtimeEvent)
          }
        } catch {}
      }

      eventSource.onerror = () => {
        eventSource.close()
      }

      return () => eventSource.close()
    }
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
