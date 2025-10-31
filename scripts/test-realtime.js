#!/usr/bin/env node

const { neon } = require('@neondatabase/serverless')
const WebSocket = require('ws')
require('dotenv').config()

const sql = neon(process.env.DATABASE_URL)

async function testRealtimeNotifications() {
  console.log('🧪 Testing Real-time PostgreSQL Notifications\n')

  // Test 1: Insert a new record to trigger notification
  console.log('📝 Test 1: Inserting a test note...')
  
  try {
    // Get an existing user first
    const existingUser = await sql`SELECT id FROM users LIMIT 1`
    
    // Insert a test saved query
    const testQuery = await sql`
      INSERT INTO saved_queries (id, name, query_sql, user_id, created_at, updated_at)
      VALUES (gen_random_uuid(), 'Test Realtime Query', 'SELECT 1 as test', ${existingUser[0].id}, NOW(), NOW())
      RETURNING id, name
    `
    
    if (testQuery.length > 0) {
      console.log(`✅ Inserted query: ${testQuery[0].name} (ID: ${testQuery[0].id})`)
      console.log('   → This should trigger a table_changes:public:saved_queries notification')
    }

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Test 2: Update the record
    console.log('\n📝 Test 2: Updating the test query...')
    
    await sql`
      UPDATE saved_queries 
      SET name = 'Updated Realtime Query', updated_at = NOW()
      WHERE id = ${testQuery[0].id}
    `
    
    console.log('✅ Updated query name')
    console.log('   → This should trigger another table_changes:public:saved_queries notification')

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Test 3: Test WebSocket connection
    console.log('\n🔌 Test 3: Testing WebSocket connection...')
    
    // Note: This assumes the test server is running (check actual port)
    const wsUrl = 'ws://localhost:8090'
    
    try {
      const ws = new WebSocket(wsUrl)
      
      ws.on('open', () => {
        console.log('✅ WebSocket connected to realtime server')
        
        // Subscribe to saved_queries table
        ws.send(JSON.stringify({
          type: 'subscribe',
          payload: {
            table: 'saved_queries',
            schema: 'public'
          }
        }))
        
        console.log('📡 Subscribed to saved_queries table changes')
      })
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          console.log('📨 Received realtime message:')
          console.log('   Type:', message.type)
          console.log('   Table:', message.table || 'N/A')
          console.log('   Payload:', JSON.stringify(message.payload, null, 2))
        } catch (error) {
          console.log('📨 Received message:', data.toString())
        }
      })
      
      ws.on('error', (error) => {
        console.log('❌ WebSocket error:', error.message)
        console.log('   Make sure the dev server is running: npm run dev')
      })
      
      // Keep connection open for a few seconds
      setTimeout(() => {
        ws.close()
        console.log('\n🔌 WebSocket connection closed')
        testCleanup(testQuery[0].id)
      }, 3000)
      
    } catch (error) {
      console.log('❌ Could not connect to WebSocket:', error.message)
      console.log('   Make sure the dev server is running: npm run dev')
      testCleanup(testQuery[0].id)
    }

  } catch (error) {
    console.error('❌ Test failed:', error)
  }
}

async function testCleanup(queryId) {
  console.log('\n🧹 Cleaning up test data...')
  
  try {
    await sql`DELETE FROM saved_queries WHERE id = ${queryId}`
    console.log('✅ Test query deleted')
    console.log('   → This should trigger a DELETE notification')
  } catch (error) {
    console.error('❌ Cleanup failed:', error)
  }
  
  console.log('\n🎉 Realtime test completed!')
  console.log('\nNext steps:')
  console.log('1. Start the dev server: npm run dev')
  console.log('2. Connect a WebSocket client to: ws://localhost:3004/realtime')
  console.log('3. Subscribe to table changes and see real-time updates!')
  
  process.exit(0)
}

if (require.main === module) {
  testRealtimeNotifications()
}

module.exports = { testRealtimeNotifications }