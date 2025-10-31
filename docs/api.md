# Kolaybase API Documentation

## Overview

Kolaybase provides a comprehensive REST API for managing PostgreSQL databases, along with real-time subscriptions and edge functions. All API endpoints require authentication via session tokens or API keys.

## Authentication

### Session Authentication
Use JWT tokens obtained through the sign-in endpoint:
```bash
curl -X POST /api/auth/sign-in \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password"}'
```

### API Key Authentication
Include your API key in the Authorization header:
```bash
curl -X GET /api/tables \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Core Endpoints

### Tables Management

#### Get All Tables
```http
GET /api/tables
```
Returns list of all tables in the database with their schemas.

**Response:**
```json
{
  "tables": [
    {
      "table_name": "users",
      "schema": "public",
      "columns": [
        {"column_name": "id", "data_type": "integer"},
        {"column_name": "email", "data_type": "text"}
      ]
    }
  ]
}
```

#### Get Table Data
```http
GET /api/tables/{tableName}/rows?limit=100&offset=0
```

**Query Parameters:**
- `limit`: Number of rows to return (default: 100)
- `offset`: Number of rows to skip (default: 0)
- `filter`: JSON filter object
- `sort`: Column to sort by
- `order`: Sort order (asc/desc)

#### Insert Row
```http
POST /api/tables/{tableName}/rows
Content-Type: application/json

{
  "email": "user@example.com",
  "name": "John Doe"
}
```

#### Update Row
```http
PATCH /api/tables/{tableName}/rows
Content-Type: application/json

{
  "filter": {"id": 1},
  "data": {"name": "Updated Name"}
}
```

#### Delete Row
```http
DELETE /api/tables/{tableName}/rows
Content-Type: application/json

{
  "filter": {"id": 1}
}
```

### SQL Execution

#### Execute SQL Query
```http
POST /api/sql/execute
Content-Type: application/json

{
  "sql": "SELECT * FROM users WHERE active = true",
  "params": []
}
```

**Response:**
```json
{
  "rows": [...],
  "rowCount": 5,
  "command": "SELECT"
}
```

### API Keys Management

#### List API Keys
```http
GET /api/api-keys
```

#### Create API Key
```http
POST /api/api-keys
Content-Type: application/json

{
  "name": "My App Key",
  "scopes": ["read:tables", "write:tables"],
  "expiresAt": "2024-12-31T23:59:59Z"
}
```

**Available Scopes:**
- `read:tables` - Read table data
- `write:tables` - Modify table data
- `read:schema` - View database schema
- `write:schema` - Modify database schema
- `read:files` - Access file storage
- `write:files` - Upload/modify files
- `admin` - Full administrative access

#### Delete API Key
```http
DELETE /api/api-keys/{keyId}
```

### File Storage

#### Upload File
```http
POST /api/storage
Content-Type: multipart/form-data

file: [binary file data]
```

#### List Files
```http
GET /api/storage?bucket=public&limit=50
```

#### Download File
```http
GET /api/storage/{fileId}
```

#### Delete File
```http
DELETE /api/storage/{fileId}
```

### Database Migrations

#### List Migrations
```http
GET /api/migrations
```

#### Run Migration
```http
POST /api/migrations/run
Content-Type: application/json

{
  "sql": "CREATE TABLE new_table (id SERIAL PRIMARY KEY);"
}
```

#### Bootstrap Database
```http
POST /api/migrations/bootstrap
```

### Row Level Security (RLS)

#### List RLS Policies
```http
GET /api/rls
```

#### Create RLS Policy
```http
POST /api/rls
Content-Type: application/json

{
  "table_name": "users",
  "policy_name": "users_select_policy",
  "command": "SELECT",
  "expression": "auth.uid() = user_id"
}
```

#### Update RLS Policy
```http
PATCH /api/rls/{policyId}
Content-Type: application/json

{
  "expression": "auth.uid() = user_id AND active = true"
}
```

#### Delete RLS Policy
```http
DELETE /api/rls/{policyId}
```

### Webhooks

#### List Webhooks
```http
GET /api/webhooks
```

#### Create Webhook
```http
POST /api/webhooks
Content-Type: application/json

{
  "url": "https://example.com/webhook",
  "events": ["INSERT", "UPDATE"],
  "table": "users",
  "secret": "webhook_secret"
}
```

#### Update Webhook
```http
PATCH /api/webhooks/{webhookId}
Content-Type: application/json

{
  "url": "https://newurl.com/webhook",
  "events": ["INSERT", "UPDATE", "DELETE"]
}
```

#### Delete Webhook
```http
DELETE /api/webhooks/{webhookId}
```

## Real-time API

### WebSocket Connection
Connect to real-time updates:
```javascript
const ws = new WebSocket('ws://localhost:3000/api/realtime');

ws.onopen = () => {
  // Subscribe to table changes
  ws.send(JSON.stringify({
    type: 'subscribe',
    table: 'users'
  }));
  
  // Join a channel
  ws.send(JSON.stringify({
    type: 'join_channel',
    channel: 'chat-room-1'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Real-time update:', data);
};
```

### Message Types

#### Table Changes
```json
{
  "type": "table_change",
  "table": "users",
  "operation": "INSERT",
  "record": {
    "id": 1,
    "email": "user@example.com"
  }
}
```

#### Channel Messages
```json
{
  "type": "broadcast",
  "channel": "chat-room-1",
  "event": "message",
  "payload": {
    "text": "Hello World!"
  }
}
```

#### Presence Updates
```json
{
  "type": "presence",
  "channel": "chat-room-1",
  "joins": [{"user_id": 1}],
  "leaves": [{"user_id": 2}]
}
```

## Edge Functions API

### List Functions
```http
GET /api/edge-functions
```

### Create Function
```http
POST /api/edge-functions
Content-Type: application/json

{
  "name": "my-function",
  "runtime": "deno",
  "code": "export default function(ctx) { return new Response('Hello!'); }",
  "environment": {
    "API_URL": "https://api.example.com"
  }
}
```

### Invoke Function
```http
POST /api/edge-functions/{functionId}/invoke
Content-Type: application/json

{
  "body": {"key": "value"},
  "headers": {"custom-header": "value"}
}
```

### Update Function
```http
PATCH /api/edge-functions/{functionId}
Content-Type: application/json

{
  "code": "export default function(ctx) { return new Response('Updated!'); }"
}
```

### Delete Function
```http
DELETE /api/edge-functions/{functionId}
```

## Secrets Management API

### List Secrets
```http
GET /api/secrets
```

### Create Secret
```http
POST /api/secrets
Content-Type: application/json

{
  "name": "API_KEY",
  "value": "secret-value-here",
  "description": "Third-party API key"
}
```

### Grant Permission
```http
POST /api/secrets/{secretName}/permissions
Content-Type: application/json

{
  "functionId": "my-function",
  "permission": "read"
}
```

### Revoke Permission
```http
DELETE /api/secrets/{secretName}/permissions/{permissionId}
```

### Delete Secret
```http
DELETE /api/secrets/{secretName}
```

## Error Handling

All API endpoints return standard HTTP status codes:

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

Error responses include a JSON object with details:
```json
{
  "error": "Validation failed",
  "message": "Email is required",
  "code": "VALIDATION_ERROR"
}
```

## Rate Limiting

API endpoints are rate limited based on your authentication method:

- **Session Auth**: 100 requests per minute
- **API Keys**: 1000 requests per minute (varies by plan)
- **Admin Keys**: 10000 requests per minute

Rate limit headers are included in responses:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1640995200
```

## OpenAPI Specification

The complete OpenAPI 3.0 specification is available at `/api/openapi.json`.

You can also view the interactive documentation at `/api-docs` when running the development server.

## SDK Examples

### JavaScript/TypeScript
```javascript
import { createClient } from '@kolaybase/sdk';

const client = createClient({
  url: 'http://localhost:3000',
  apiKey: 'your-api-key'
});

// Fetch data
const { data } = await client.from('users').select('*');

// Insert data
await client.from('users').insert({ 
  email: 'user@example.com',
  name: 'John Doe' 
});

// Real-time subscription
client.realtime
  .subscribe('users')
  .on('INSERT', (payload) => {
    console.log('New user:', payload);
  });
```

### cURL Examples

```bash
# Authenticate
curl -X POST http://localhost:3000/api/auth/sign-in \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@kolaybase.com", "password": "admin123"}'

# Create API key
curl -X POST http://localhost:3000/api/api-keys \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Key", "scopes": ["read:tables"]}'

# Query data
curl -X GET http://localhost:3000/api/tables/users/rows \
  -H "Authorization: Bearer API_KEY"

# Insert data
curl -X POST http://localhost:3000/api/tables/users/rows \
  -H "Authorization: Bearer API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "name": "Test User"}'
```