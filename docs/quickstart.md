# Quick Start

## Requirements

- Docker 24+
- Docker Compose v2
- Node.js 20+

## Local Setup

### 1. Clone the repository

```bash
git clone https://github.com/myfyio/basefyio.git
cd basefyio
```

### 2. Configure environment

```bash
cp .env.example .env
```

The defaults work for local development. Edit `.env` if you need different ports or credentials.

### 3. Start the stack

```bash
docker compose up -d
```

This starts:
- PostgreSQL (port 5433)
- Keycloak (port 8080)
- Redis (port 6379)
- MinIO (port 9000 / console 9001)
- PgBouncer (port 6432)
- Platform API (port 4000)
- Admin UI (port 3000)

### 4. Wait for services to be ready

```bash
docker compose ps
```

All services should show `healthy` or `running`. Keycloak takes ~30 seconds on first start.

### 5. Access the Admin UI

Open http://localhost:3000

Default credentials: `admin` / `admin`

### 6. Create your first project

Via the Admin UI, click **New Project** and fill in the name and slug.

Or via the API:

```bash
# Get a token first
TOKEN=$(curl -s -X POST http://localhost:8080/realms/master/protocol/openid-connect/token \
  -d "client_id=admin-cli&username=admin&password=admin&grant_type=password" \
  | jq -r '.access_token')

# Create a project
curl -X POST http://localhost:4000/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My App", "slug": "my-app"}'
```

## Connecting Your App

### JavaScript / TypeScript

```bash
npm install @basefyio/sdk
```

```ts
import { createClient } from '@basefyio/sdk'

const client = createClient({
  url: 'http://localhost:4000',
  projectSlug: 'my-app',
  apiKey: 'your-project-api-key'
})

// Execute SQL
const { data, error } = await client.sql('SELECT now()')

// Query structured data
const { data: users } = await client.from('users').select('*').limit(10)
```

### REST API

```bash
# List projects
curl http://localhost:4000/projects \
  -H "Authorization: Bearer $TOKEN"

# Execute SQL
curl -X POST http://localhost:4000/projects/my-app/sql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT * FROM users LIMIT 5"}'
```

## Stopping the Stack

```bash
docker compose down
```

To also remove volumes (all data):

```bash
docker compose down -v
```

## Troubleshooting

**Keycloak not ready:**
```bash
docker compose logs keycloak --tail 20
```

**Platform API errors:**
```bash
docker compose logs platform-api --tail 50
```

**Reset everything:**
```bash
docker compose down -v
docker compose up -d
```
