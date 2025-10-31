# Real-time WebSocket Server Implementation Guide

## ✅ Completed Components

### 1. JWT Authentication ✅
- **File:** `lib/realtime.ts`
- **Changes:** 
  - Implemented `validateToken()` method with JWT verification
  - Added API key fallback authentication
  - Enhanced `extractTokenFromRequest()` to check headers and query params
- **Status:** Complete

### 2. PostgreSQL Integration ✅
- **File:** `scripts/realtime-triggers.sql`
- **Changes:**
  - Created `notify_table_change()` trigger function
  - Added `enable_realtime_for_table()` helper function
  - Added `disable_realtime_for_table()` helper function
- **Status:** Complete (needs to be run in database)

### 3. LISTEN/NOTIFY Implementation ✅
- **File:** `lib/realtime.ts`
- **Changes:**
  - Replaced `simulateWALListening()` with `setupPostgreSQLListener()`
  - Added `setupListenNotify()` for traditional PostgreSQL
  - Added `setupPollingListener()` for serverless databases (fallback)
  - Implemented `handleTableChange()` to broadcast changes
- **Status:** Complete (auto-detects serverless vs traditional PostgreSQL)

### 4. Server Integration ✅
- **File:** `server.ts`
- **Changes:**
  - Created custom Next.js server with WebSocket support
  - Integrated `RealtimeServer` initialization
- **Status:** Complete (alternative to API route approach)

### 5. Client SDK Update ✅
- **File:** `lib/kolaybase.ts`
- **Changes:**
  - Replaced mock implementation with real WebSocket client
  - Added `connect()` method returning WebSocket connection
  - Implemented reconnection logic
  - Added channel support with presence and broadcast
  - Maintained backward compatibility with legacy `subscribe()` method
- **Status:** Complete

## 📋 Setup Instructions

### Step 1: Install Dependencies

For traditional PostgreSQL (non-serverless), you'll need the `pg` package:

```bash
npm install pg
npm install --save-dev @types/pg
```

For serverless databases (Neon, Supabase), the polling fallback will be used automatically.

### Step 2: Set Up Database Triggers

Run the trigger setup script in your database:

```bash
psql $DATABASE_URL -f scripts/realtime-triggers.sql
```

Or manually in your database:

```sql
\i scripts/realtime-triggers.sql
```

### Step 3: Enable Realtime for Specific Tables

After running the trigger setup, enable realtime for tables you want to monitor:

```sql
-- Enable realtime for a specific table
SELECT enable_realtime_for_table('public', 'notes');
SELECT enable_realtime_for_table('public', 'posts');
```

### Step 4: Choose Server Setup Option

#### Option A: Custom Server (Recommended for Production)

Use the custom server for WebSocket support:

1. Update `package.json`:
```json
{
  "scripts": {
    "dev": "node server.ts",
    "start": "node server.ts",
    "build": "next build"
  }
}
```

2. Install TypeScript runner if needed:
```bash
npm install --save-dev tsx
# Or use ts-node
```

3. Run with custom server:
```bash
npm run dev
```

#### Option B: API Route (For Vercel/Serverless)

For Vercel deployment, WebSocket upgrade won't work with API routes. You'll need:
- A separate WebSocket service (like Pusher, Ably, or self-hosted)
- Or use Server-Sent Events (SSE) which works with API routes (current implementation)

### Step 5: Test the Implementation

```typescript
import { kolaybase } from '@/lib/kolaybase'

// Connect to realtime
const client = kolaybase.realtime.connect()

// Subscribe to table changes
const unsubscribe = client.subscribe('notes', 'public', (event) => {
  console.log('Table change:', event)
})

// Join a channel
const channel = client.channel('chat-room-1')
channel.subscribe()

// Send broadcast message
channel.send('message', { text: 'Hello!' })

// Listen for presence changes
channel.onPresence((presence) => {
  console.log('Users online:', presence)
})

// Clean up
setTimeout(() => {
  unsubscribe()
  channel.unsubscribe()
  client.disconnect()
}, 10000)
```

## 🔧 Configuration

### Environment Variables

```env
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret-key
DB_PROVIDER=neon  # or 'postgres' for traditional PostgreSQL
```

### Database Provider Detection

The system auto-detects serverless databases:
- If `DATABASE_URL` contains "serverless" → uses polling
- If `DB_PROVIDER=neon` → uses polling
- Otherwise → uses LISTEN/NOTIFY with persistent connection

## 🐛 Troubleshooting

### WebSocket Connection Failed

1. **Check server is running:** Ensure custom server (`server.ts`) is being used
2. **Check URL:** WebSocket URL should be `ws://localhost:3000/realtime`
3. **Check authentication:** Token should be passed in query param or header

### No Notifications Received

1. **Check triggers:** Ensure triggers are installed: `\df notify_table_change`
2. **Check table enabled:** Verify realtime is enabled: `SELECT * FROM pg_trigger WHERE tgname LIKE 'realtime_trigger%'`
3. **Check subscription:** Verify client is subscribed to correct table/schema
4. **Check database type:** Serverless databases use polling (2-second interval)

### Authentication Errors

1. **Check JWT_SECRET:** Must match token signing secret
2. **Check token format:** Should be valid JWT or API key
3. **Check user exists:** User must exist in `users` table with `is_active = true`

## 📊 Performance Considerations

### Traditional PostgreSQL
- Uses persistent connection for LISTEN/NOTIFY
- Real-time (sub-second latency)
- Requires connection pool management

### Serverless PostgreSQL (Neon)
- Uses polling fallback (2-second intervals)
- Slightly higher latency but works with serverless
- No persistent connection needed

### Connection Limits
- Each WebSocket connection consumes one connection slot
- Monitor connection count: `realtimeServer.getConnectionCount()`
- Implement connection limits if needed

## 🔐 Security Notes

1. **Authentication:** All connections should be authenticated
2. **Authorization:** Channel access is checked via `canAccessChannel()`
3. **RLS Policies:** Database RLS policies still apply to data
4. **Rate Limiting:** Consider adding rate limiting for WebSocket connections

## 🚀 Next Steps

1. **Monitoring:** Add metrics for connection count, message throughput
2. **Scaling:** Consider Redis pub/sub for multi-instance deployments
3. **Testing:** Add integration tests for WebSocket functionality
4. **Documentation:** Add examples for common use cases

## 📝 API Reference

### Server-Side

```typescript
// Initialize server (called from server.ts)
realtimeServer.initialize(httpServer)

// Broadcast change manually
realtimeServer.broadcast('table', 'schema', {
  type: 'insert',
  new: { id: '123', name: 'Test' },
  old: null
})

// Get connection count
const count = realtimeServer.getConnectionCount()

// Create channel
const channelId = await realtimeServer.createChannel('My Channel', 'chat')
```

### Client-Side

```typescript
// Connect
const client = kolaybase.realtime.connect()

// Subscribe to table
const unsubscribe = client.subscribe('table', 'schema', (event) => {
  // Handle event
})

// Channel operations
const channel = client.channel('channel-id')
channel.subscribe()
channel.send('event', { data: 'value' })
channel.onPresence((presence) => {})
channel.onMessage('event', (payload) => {})

// Disconnect
client.disconnect()
```

---

**Implementation Date:** 2024-12-28  
**Status:** ✅ Complete - Ready for testing

