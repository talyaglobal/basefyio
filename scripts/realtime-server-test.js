#!/usr/bin/env node

const { WebSocketServer } = require('ws')
const { neon } = require('@neondatabase/serverless')
require('dotenv').config()

const sql = neon(process.env.DATABASE_URL)

// Simple WebSocket server for testing realtime functionality
const PORT = 8090

const wss = new WebSocketServer({ port: PORT })
const subscriptions = new Map()

console.log(`🚀 Test WebSocket server started on ws://localhost:${PORT}`)

wss.on('connection', (ws) => {
  console.log('📡 WebSocket client connected')
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString())
      console.log('📨 Received message:', data)
      
      if (data.type === 'subscribe' && data.payload?.table) {
        const channelName = `table_changes:public:${data.payload.table}`
        subscriptions.set(ws, channelName)
        console.log(`✅ Subscribed to channel: ${channelName}`)
        
        ws.send(JSON.stringify({
          type: 'subscription_success',
          channel: channelName,
          message: `Subscribed to ${data.payload.table} changes`
        }))
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error)
    }
  })
  
  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected')
    subscriptions.delete(ws)
  })
  
  // Send heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        timestamp: new Date().toISOString()
      }))
    }
  }, 30000)
  
  ws.on('close', () => clearInterval(heartbeatInterval))
})

// Simulate some database notifications for testing
async function simulateNotifications() {
  console.log('\n🧪 Starting notification simulation...')
  
  // Simulate database change notifications
  setInterval(() => {
    const mockNotification = {
      type: 'INSERT',
      schema: 'public',
      table: 'saved_queries',
      new_record: {
        id: 'test-' + Date.now(),
        name: 'Mock Query ' + Date.now(),
        query_sql: 'SELECT * FROM test'
      },
      timestamp: Date.now()
    }
    
    // Send to all subscribers
    subscriptions.forEach((channelName, ws) => {
      if (channelName === 'table_changes:public:saved_queries' && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'table_change',
          channel: channelName,
          payload: mockNotification
        }))
        console.log('📤 Sent mock notification to subscriber')
      }
    })
  }, 10000) // Every 10 seconds
}

// Start simulation after a short delay
setTimeout(simulateNotifications, 5000)

console.log('\n📋 Test Instructions:')
console.log('1. Run: node scripts/test-realtime.js')
console.log('2. This server will send mock notifications every 10 seconds')
console.log('3. Watch for WebSocket messages in the test output')