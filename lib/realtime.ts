import { WebSocketServer, WebSocket } from 'ws'
import { neon } from '@neondatabase/serverless'
import { IncomingMessage, Server } from 'http'
import { getUser } from './auth'

export interface RealtimeMessage {
  type: 'insert' | 'update' | 'delete' | 'error' | 'heartbeat' | 'presence' | 'broadcast'
  payload: any
  timestamp: string
  table?: string
  schema?: string
  channel?: string
}

export interface PresenceState {
  user_id: string
  username?: string
  avatar?: string
  online_at: string
  metadata?: Record<string, any>
}

export interface RealtimeChannel {
  id: string
  name: string
  topic: string
  authorized_users?: string[]
  created_at: string
  settings: {
    presence_enabled: boolean
    broadcast_enabled: boolean
    postgres_changes_enabled: boolean
    max_connections?: number
  }
}

class RealtimeConnection {
  private ws: WebSocket
  private userId?: string
  private subscriptions: Set<string> = new Set()
  private presenceState?: PresenceState
  private lastHeartbeat: number = Date.now()
  private channels: Set<string> = new Set()

  constructor(ws: WebSocket, userId?: string) {
    this.ws = ws
    this.userId = userId
    this.setupHeartbeat()
  }

  private setupHeartbeat() {
    const heartbeatInterval = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.send({
          type: 'heartbeat',
          payload: { timestamp: new Date().toISOString() },
          timestamp: new Date().toISOString()
        })
      } else {
        clearInterval(heartbeatInterval)
      }
    }, 30000) // 30 second heartbeat
  }

  send(message: RealtimeMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  subscribe(table: string, schema: string = 'public') {
    const subscription = `${schema}:${table}`
    this.subscriptions.add(subscription)
  }

  unsubscribe(table: string, schema: string = 'public') {
    const subscription = `${schema}:${table}`
    this.subscriptions.delete(subscription)
  }

  joinChannel(channelId: string) {
    this.channels.add(channelId)
  }

  leaveChannel(channelId: string) {
    this.channels.delete(channelId)
  }

  hasSubscription(table: string, schema: string = 'public'): boolean {
    return this.subscriptions.has(`${schema}:${table}`)
  }

  isInChannel(channelId: string): boolean {
    return this.channels.has(channelId)
  }

  getChannels(): Set<string> {
    return this.channels
  }

  updatePresence(state: Partial<PresenceState>) {
    if (this.userId) {
      this.presenceState = {
        user_id: this.userId,
        online_at: new Date().toISOString(),
        ...this.presenceState,
        ...state
      }
    }
  }

  getPresence(): PresenceState | undefined {
    return this.presenceState
  }

  close() {
    this.ws.close()
  }

  get isAlive(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  get user(): string | undefined {
    return this.userId
  }

  pong() {
    this.lastHeartbeat = Date.now()
  }

  get lastSeen(): number {
    return this.lastHeartbeat
  }
}

export class RealtimeServer {
  private wss?: WebSocketServer
  private connections: Map<string, RealtimeConnection> = new Map()
  private sql = neon(process.env.DATABASE_URL!)
  private channels: Map<string, RealtimeChannel> = new Map()
  private walListenerActive = false

  constructor() {
    this.initializeChannels()
  }

  private async initializeChannels() {
    // Load channels from database
    try {
      const result = await this.sql`
        SELECT * FROM realtime_channels 
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
      `
      
      for (const channel of result) {
        this.channels.set(channel.id, {
          id: channel.id,
          name: channel.name,
          topic: channel.topic,
          authorized_users: channel.authorized_users || [],
          created_at: channel.created_at,
          settings: channel.settings || {
            presence_enabled: true,
            broadcast_enabled: true,
            postgres_changes_enabled: true
          }
        })
      }
    } catch (error) {
      console.error('Failed to load realtime channels:', error)
    }
  }

  async initialize(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/realtime' })

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req)
    })

    // Start WAL listener for PostgreSQL changes
    this.startWALListener()

    console.log('🔄 Realtime server initialized')
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage) {
    const connectionId = this.generateConnectionId()
    
    // Try to authenticate user from token
    let userId: string | undefined
    try {
      const token = this.extractTokenFromRequest(req)
      if (token) {
        // You would validate the token here
        // For now, we'll use a placeholder
        userId = await this.validateToken(token)
      }
    } catch (error) {
      console.error('Authentication failed:', error)
    }

    const connection = new RealtimeConnection(ws, userId)
    this.connections.set(connectionId, connection)

    console.log(`📡 New realtime connection: ${connectionId} (user: ${userId || 'anonymous'})`)

    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString())
        await this.handleMessage(connectionId, message)
      } catch (error) {
        console.error('Failed to process message:', error)
        connection.send({
          type: 'error',
          payload: { message: 'Invalid message format' },
          timestamp: new Date().toISOString()
        })
      }
    })

    ws.on('close', () => {
      this.handleDisconnection(connectionId)
    })

    ws.on('pong', () => {
      connection.pong()
    })

    // Send welcome message
    connection.send({
      type: 'heartbeat',
      payload: { 
        message: 'Connected to Kolaybase Realtime',
        connection_id: connectionId,
        user_id: userId
      },
      timestamp: new Date().toISOString()
    })
  }

  private async handleMessage(connectionId: string, message: any) {
    const connection = this.connections.get(connectionId)
    if (!connection) return

    switch (message.type) {
      case 'subscribe':
        await this.handleSubscribe(connection, message)
        break
      case 'unsubscribe':
        await this.handleUnsubscribe(connection, message)
        break
      case 'presence':
        await this.handlePresence(connection, message)
        break
      case 'broadcast':
        await this.handleBroadcast(connection, message)
        break
      case 'ping':
        connection.send({
          type: 'heartbeat',
          payload: { pong: true },
          timestamp: new Date().toISOString()
        })
        break
    }
  }

  private async handleSubscribe(connection: RealtimeConnection, message: any) {
    const { table, schema = 'public', channel } = message.payload

    if (channel) {
      // Channel subscription
      const channelData = this.channels.get(channel)
      if (channelData && this.canAccessChannel(connection.user, channelData)) {
        connection.joinChannel(channel)
        connection.send({
          type: 'presence',
          payload: { 
            event: 'joined_channel',
            channel: channel,
            presence: this.getChannelPresence(channel)
          },
          timestamp: new Date().toISOString(),
          channel
        })
      } else {
        connection.send({
          type: 'error',
          payload: { message: 'Access denied to channel' },
          timestamp: new Date().toISOString()
        })
      }
    } else if (table) {
      // Table subscription
      connection.subscribe(table, schema)
      connection.send({
        type: 'heartbeat',
        payload: { 
          event: 'subscribed',
          table,
          schema 
        },
        timestamp: new Date().toISOString()
      })
    }
  }

  private async handleUnsubscribe(connection: RealtimeConnection, message: any) {
    const { table, schema = 'public', channel } = message.payload

    if (channel) {
      connection.leaveChannel(channel)
    } else if (table) {
      connection.unsubscribe(table, schema)
    }

    connection.send({
      type: 'heartbeat',
      payload: { 
        event: 'unsubscribed',
        table,
        schema,
        channel 
      },
      timestamp: new Date().toISOString()
    })
  }

  private async handlePresence(connection: RealtimeConnection, message: any) {
    const { channel, state } = message.payload

    if (connection.isInChannel(channel)) {
      connection.updatePresence(state)
      
      // Broadcast presence update to all channel members
      this.broadcastToChannel(channel, {
        type: 'presence',
        payload: {
          event: 'presence_update',
          user_id: connection.user,
          state: connection.getPresence()
        },
        timestamp: new Date().toISOString(),
        channel
      }, connection.user)
    }
  }

  private async handleBroadcast(connection: RealtimeConnection, message: any) {
    const { channel, event, payload } = message.payload

    if (connection.isInChannel(channel)) {
      this.broadcastToChannel(channel, {
        type: 'broadcast',
        payload: {
          event,
          payload,
          user_id: connection.user
        },
        timestamp: new Date().toISOString(),
        channel
      }, connection.user)
    }
  }

  private broadcastToChannel(channelId: string, message: RealtimeMessage, excludeUserId?: string) {
    for (const [_, connection] of this.connections) {
      if (connection.isInChannel(channelId) && connection.user !== excludeUserId) {
        connection.send(message)
      }
    }
  }

  private getChannelPresence(channelId: string): PresenceState[] {
    const presence: PresenceState[] = []
    
    for (const [_, connection] of this.connections) {
      if (connection.isInChannel(channelId)) {
        const state = connection.getPresence()
        if (state) {
          presence.push(state)
        }
      }
    }

    return presence
  }

  private canAccessChannel(userId: string | undefined, channel: RealtimeChannel): boolean {
    if (!channel.authorized_users || channel.authorized_users.length === 0) {
      return true // Public channel
    }
    
    return userId ? channel.authorized_users.includes(userId) : false
  }

  private async startWALListener() {
    if (this.walListenerActive) return

    try {
      // In a real implementation, you would use pg_notify or a WAL listener
      // For now, we'll simulate it with polling
      this.walListenerActive = true
      this.simulateWALListening()
      console.log('📊 WAL listener started')
    } catch (error) {
      console.error('Failed to start WAL listener:', error)
    }
  }

  private simulateWALListening() {
    // This is a simplified simulation
    // In production, you'd use PostgreSQL's logical replication or LISTEN/NOTIFY
    setInterval(async () => {
      // Check for changes and broadcast to subscribers
      // This is where you'd implement actual WAL parsing
    }, 1000)
  }

  broadcast(table: string, schema: string, change: any) {
    const message: RealtimeMessage = {
      type: change.type,
      payload: {
        schema,
        table,
        old_record: change.old,
        new_record: change.new,
        commit_timestamp: change.timestamp
      },
      timestamp: new Date().toISOString(),
      table,
      schema
    }

    for (const [_, connection] of this.connections) {
      if (connection.hasSubscription(table, schema)) {
        connection.send(message)
      }
    }
  }

  private handleDisconnection(connectionId: string) {
    const connection = this.connections.get(connectionId)
    if (connection) {
      // Broadcast presence leave events
      for (const channelId of connection.getChannels()) {
        this.broadcastToChannel(channelId, {
          type: 'presence',
          payload: {
            event: 'user_left',
            user_id: connection.user
          },
          timestamp: new Date().toISOString(),
          channel: channelId
        }, connection.user)
      }

      connection.close()
      this.connections.delete(connectionId)
      console.log(`📡 Realtime connection closed: ${connectionId}`)
    }
  }

  private generateConnectionId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36)
  }

  private extractTokenFromRequest(req: IncomingMessage): string | null {
    // Try query parameter first
    const url = new URL(req.url || '', 'http://localhost')
    const tokenParam = url.searchParams.get('token')
    if (tokenParam) return tokenParam
    
    // Try Authorization header (Bearer token)
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7)
    }
    
    // Try x-api-key header
    const apiKey = req.headers['x-api-key']
    if (apiKey && typeof apiKey === 'string') {
      return apiKey
    }
    
    return null
  }

  private async validateToken(token: string): Promise<string | undefined> {
    try {
      const { jwtVerify } = await import('jose')
      const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'fallback-secret')
      
      try {
        const { payload } = await jwtVerify(token, secret)
        
        // Extract user ID from token payload
        const userId = payload.sub || payload.userId || payload.id
        
        if (typeof userId === 'string') {
          // Verify user exists in database
          const user = await this.sql`
            SELECT id FROM users WHERE id = ${userId} AND is_active = true
            LIMIT 1
          `
          
          if (user.length > 0) {
            return user[0].id
          }
        }
      } catch (error) {
        // Token might be an API key instead
        const { hashApiKey } = await import('./api-key-utils')
        const hashedKey = await hashApiKey(token)
        
        const apiKeys = await this.sql`
          SELECT user_id FROM api_keys
          WHERE hashed_key = ${hashedKey} AND is_active = true
          AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1
        `
        
        if (apiKeys.length > 0) {
          return apiKeys[0].user_id
        }
      }
    } catch (error) {
      console.error('Token validation error:', error)
    }
    
    return undefined
  }

  async createChannel(name: string, topic: string, settings?: Partial<RealtimeChannel['settings']>): Promise<string> {
    const channelId = `channel_${Date.now()}_${Math.random().toString(36).substring(2)}`
    
    const channel: RealtimeChannel = {
      id: channelId,
      name,
      topic,
      created_at: new Date().toISOString(),
      settings: {
        presence_enabled: true,
        broadcast_enabled: true,
        postgres_changes_enabled: true,
        ...settings
      }
    }

    // Save to database
    await this.sql`
      INSERT INTO realtime_channels (id, name, topic, settings, created_at)
      VALUES (${channelId}, ${name}, ${topic}, ${JSON.stringify(channel.settings)}, NOW())
    `

    this.channels.set(channelId, channel)
    return channelId
  }

  getConnectionCount(): number {
    return this.connections.size
  }

  getChannels(): RealtimeChannel[] {
    return Array.from(this.channels.values())
  }
}

export const realtimeServer = new RealtimeServer()